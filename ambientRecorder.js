import { LightningElement, api, track, wire } from 'lwc';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import CONTACT_NAME from '@salesforce/schema/Contact.Name';
import CONTACT_BIRTHDATE from '@salesforce/schema/Contact.Birthdate';
import CONTACT_GENDER from '@salesforce/schema/Contact.Gender';
import startSession from '@salesforce/apex/AmbientCaptureController.startSession';
import endSession from '@salesforce/apex/AmbientCaptureController.endSession';
import storeAudio from '@salesforce/apex/AmbientCaptureController.storeAudio';
import createJob from '@salesforce/apex/SarvamBatchController.createJob';
import uploadBlock from '@salesforce/apex/SarvamBatchController.uploadBlock';
import commitBlocks from '@salesforce/apex/SarvamBatchController.commitBlocks';
import startJob from '@salesforce/apex/SarvamBatchController.startJob';
import pollJob from '@salesforce/apex/SarvamBatchController.pollJob';
import transcribeChunk from '@salesforce/apex/SarvamBatchController.transcribeChunk';
import saveTranscript from '@salesforce/apex/ConsultationDraftController.saveTranscript';
import generateDraft from '@salesforce/apex/ConsultationDraftController.generateDraft';
import createFromDraft from '@salesforce/apex/PrescriptionController.createFromDraft';
import buildPrescriptionPdf from '@salesforce/apex/PrescriptionPdfController.build';
import savePrescriptionEdits from '@salesforce/apex/PrescriptionEditController.saveEdits';

/**
 * Bedside ambient capture, transcribed by Sarvam after the recording closes.
 *
 * The browser keeps the microphone and nothing else. It captures 16 kHz mono
 * PCM, wraps it as one WAV when recording stops, and sends that to Sarvam,
 * which returns the conversation split by speaker.
 *
 * One request for the whole recording, never a chunk at a time. Speaker identity
 * is scoped to a single request, so "Speaker 0" in one chunk has no relationship
 * to "Speaker 0" in the next — chunking is what scrambled speakers in an earlier
 * design. It also means there is no word-by-word live transcript: Sarvam
 * diarizes only in its batch API, and speaker attribution is worth more to the
 * draft than watching the words land.
 *
 * The key stays server-side. Apex opens the job and hands back a presigned
 * storage URL that is write-only and single-object, so the browser can upload
 * the audio without ever holding a credential.
 *
 * Stopping the recording also files the conversation as a single
 * Consultation_Transcript__c document, which is what the clinical draft is
 * generated from.
 */
const LOW_CONFIDENCE = 0.85;
const BUFFER_SIZE = 4096;

/**
 * Sarvam accepts 8 kHz or 16 kHz and nothing else, so the graph is pinned here
 * rather than left at the device rate. Chrome hands back 48 kHz by default,
 * which Sarvam rejects outright — and 16 kHz is the rate speech models are
 * trained on anyway, so nothing is lost by resampling on the way in.
 */
const SAMPLE_RATE = 16000;

/** WAV is 16-bit mono PCM here; two bytes a sample, one channel. */
const BYTES_PER_SAMPLE = 2;

/**
 * Bytes of audio per upload call.
 *
 * Sized against the Apex heap rather than the network: a slice arrives base64'd,
 * about a third larger, and Apex holds the encoded string and the decoded blob
 * at the same time. 700 KB keeps that pair near 1.7 MB against a 6 MB ceiling,
 * with room for a longer consultation than anyone is going to record.
 */
const UPLOAD_BLOCK_BYTES = 700000;

/**
 * How much speech to gather before sending it for a live preview.
 *
 * This is the whole latency budget: words appear roughly this long after they
 * are said, plus a second for the round trip. Shorter feels more live but slices
 * mid-word and costs accuracy, since each slice is transcribed with no knowledge
 * of the ones around it. Ten seconds keeps sentences mostly intact.
 */
const LIVE_CHUNK_MS = 10000;

/** Below this there is not enough speech in a slice to be worth sending. */
const LIVE_MIN_SAMPLES = 8000;

/**
 * Shortest recording worth blaming the audio for.
 *
 * Under this, an empty transcript says more about the length of the recording
 * than about the microphone, and telling someone to check their input device
 * when they recorded for two seconds sends them after the wrong fault.
 */
const MIN_USEFUL_SECONDS = 5;

/** How often to ask Sarvam whether the job is done. */
const POLL_INTERVAL_MS = 2000;

/**
 * Ceiling on the whole transcription wait. A two-minute consultation comes back
 * in a few seconds; this only has to beat a job that never finishes.
 */
const POLL_TIMEOUT_MS = 180000;

/**
 * How close to the bottom of the transcript still counts as watching the live
 * edge. Wide enough to survive a stray trackpad nudge, narrow enough that
 * deliberately scrolling back one turn stops the auto-follow.
 */
const LIVE_EDGE_PX = 48;

/**
 * Ceiling on the audio upload. Nothing downstream depends on it finishing, and
 * it must never be able to strand the steps that follow.
 */
const AUDIO_TIMEOUT_MS = 15000;

/**
 * Bitrate for the retained copy of the audio.
 *
 * Mono speech at 24 kbps is comfortably intelligible, and it is the difference
 * between a long consultation fitting in a single Apex call and not fitting.
 * Chrome defaults far higher, which is what put a 6-minute visit over the line.
 */
const AUDIO_BITS_PER_SECOND = 24000;

/**
 * Largest recording the backup will attempt in one call.
 *
 * storeAudio holds the base64 string and the decoded blob in heap at the same
 * time, so the ceiling is roughly a third under the 6 MB sync limit. Past this
 * the call fails as aura:systemError, which reads like a broken component
 * rather than a file that was too big — so it is not attempted, and the reason
 * is stated instead.
 */
const AUDIO_MAX_BYTES = 2000000;

/**
 * Where the console's view state is parked so a page reload redraws it.
 *
 * sessionStorage, not localStorage, and the difference matters here. A
 * consultation left on screen is patient data; localStorage would keep it on
 * the workstation after the tab closed and the clinician walked away, where the
 * next person to open the browser would find it. sessionStorage is scoped to
 * the tab, so it satisfies the requirement — a reload keeps the transcript —
 * and still ends when the tab does. Swap the two words below if the transcript
 * genuinely has to outlive the tab, but that is a privacy decision, not a
 * technical one.
 */
const STORE = 'sessionStorage';
const STORE_PREFIX = 'ambientRecorder';

export default class AmbientRecorder extends LightningElement {
    @api recordId;

    @track segments = [];
    state = 'idle'; // idle | connecting | recording | saving | error
    elapsed = 0;
    errorMessage = '';

    sessionId = null;
    stream = null;
    audioContext = null;
    processor = null;
    source = null;
    recorder = null;
    recordedParts = [];

    // The consultation as 16-bit PCM, kept so it can be sent as one WAV once
    // recording closes. Sarvam only diarizes in its batch API, so the whole
    // conversation has to arrive in one piece — speaker identity is scoped to a
    // single request, and chunking it is what scrambled speakers before.
    pcmChunks = [];
    pcmSamples = 0;

    /**
     * The rate the graph actually ran at, captured while it was running.
     *
     * Not read back from the context at the end: stopAudioGraph closes and nulls
     * it, so asking later would build a fresh context and report whatever that
     * one negotiated. If the original had fallen back to 48 kHz and the new one
     * reported 16 kHz, the WAV header would declare a rate the samples do not
     * have, and the whole consultation would transcribe as chipmunk.
     */
    captureRate = SAMPLE_RATE;

    /** How much of the recording has reached storage, for the status line. */
    uploadPercent = 0;

    // Live preview bookkeeping. liveChunkIndex is how far through pcmChunks the
    // preview has already been sent, so each slice covers only new speech.
    liveTimer = null;
    liveChunkIndex = 0;
    liveBusy = false;
    liveSeconds = 0;
    saveTimer = null;
    tickId = null;
    closing = false;
    opened = false;

    // Live input diagnostics. Without these, "nothing was transcribed" is
    // unfalsifiable — a dead microphone and silence look identical, and only one
    // of them is worth telling the clinician about.
    level = 0;
    sessionPeak = 0;
    frameCount = 0;

    // The retained audio copy is evidence, not the deliverable, so a problem
    // with it is reported apart from errorMessage. Sharing that channel put a
    // red alert on a consultation that had transcribed and drafted perfectly.
    audioNotice = '';

    // Why the live preview last failed, if it did. Not shown during the
    // consultation; used to explain an empty transcript afterwards.
    liveError = '';

    /**
     * Why transcription last failed. Held, not shown.
     *
     * Suppressed on request: these arrive after the recording is safely kept
     * and the live transcript exists, so the consultation carries on either
     * way. Recorded here rather than discarded so the reason is still
     * recoverable — a quota error like "No credits available" is a billing
     * problem nobody can act on from this screen, but it is the answer when
     * someone asks why the turns have no speakers.
     */
    lastTranscriptionError = '';

    // Whether the transcript should stay pinned to the newest turn. Tracked from
    // the user's own scrolling rather than measured at render time: by the time
    // a new turn is in the DOM the distance to the bottom has already grown by
    // its height, which reads as "scrolled away" when nobody moved.
    followLive = true;
    renderedTurnCount = 0;

    // The filed consultation, and the draft generated from it.
    transcriptId = null;
    transcriptName = '';
    @track draft = null;
    draftState = 'idle'; // idle | loading | ready | error
    draftError = '';
    rawDraft = '';
    showDraft = false;
    // The Draft prescription filed from the draft above. Recorded separately
    // from draftState because filing can fail while the draft itself is fine.
    prescriptionName = '';
    prescriptionError = '';

    // Kept apart from prescriptionError: a failed download costs a file, while
    // a failed filing costs the record, and they are not equally serious.
    pdfBusy = false;
    pdfError = '';

    // Correcting the medication rows. The ids come back from filing; without
    // them there is no record to correct, and the button says so rather than
    // letting an edit be typed and then dropped.
    prescriptionId = '';
    prescriptionItemIds = [];
    @track rxEdits = [];
    @track rxDxEdits = [];
    @track rxInvEdits = [];
    isEditingRx = false;
    rxSaving = false;
    rxEditError = '';
    /** Only used to key added investigation rows, which have no draft index. */
    invKeySeed = 0;
    // The patient this consultation is being recorded for. Chosen by the
    // clinician, never inferred: the transcript names people the way people talk,
    // and matching a spoken name to a record is a guess this cannot afford.
    patientContactId = null;
    patientName = '';
    patientBirthdate = null;
    patientGender = '';

    // On by default: the quote is the point. A line the clinician cannot trace
    // back to something that was actually said is not reviewable.
    showEvidence = true;

    // ---------------------------------------------------------------- lifecycle

    connectedCallback() {
        this.restore();
    }

    disconnectedCallback() {
        this.teardown();
    }

    renderedCallback() {
        this.keepLatestTurnInView();
    }

    /**
     * Follows the conversation as it grows, but only while the clinician is
     * already at the live edge. Yanking them back down mid-sentence because a
     * new turn landed would make reading anything earlier impossible, and a
     * long consultation is exactly when they need to look back.
     */
    keepLatestTurnInView() {
        const count = this.segments.length;
        if (count === this.renderedTurnCount) {
            return;
        }
        this.renderedTurnCount = count;
        if (!this.followLive) {
            return;
        }
        const box = this.template.querySelector('.transcript');
        if (box) {
            box.scrollTop = box.scrollHeight;
        }
    }

    /** Uncapped while there is nothing to scroll, so the empty state sits at its
     *  natural height instead of inside a tall, mostly blank box. */
    get transcriptClass() {
        return this.hasSegments ? 'transcript' : 'transcript transcript_empty';
    }

    handleTranscriptScroll(event) {
        const box = event.target;
        this.followLive =
            box.scrollHeight - box.scrollTop - box.clientHeight <= LIVE_EDGE_PX;
    }

    // ------------------------------------------------------------------- patient

    /**
     * Resolves the picked Contact to a name, so the draft can say who it is for
     * without waiting for the prescription to be filed. The picker only hands
     * back an id, and the id is not something a clinician can check.
     *
     * Skipped while nothing is selected — a null reactive id never provisions.
     */
    // Name is required; the demographics are optional on purpose. Asking for
    // Gender as a required field would fail the whole wire wherever field-level
    // security hides it, taking the patient's name down with it — and the name
    // is the one thing this sheet cannot be read without.
    @wire(getRecord, {
        recordId: '$patientContactId',
        fields: [CONTACT_NAME],
        optionalFields: [CONTACT_BIRTHDATE, CONTACT_GENDER]
    })
    wiredPatient({ data, error }) {
        if (!data || error) {
            this.clearPatient();
            return;
        }
        this.patientName = getFieldValue(data, CONTACT_NAME) || '';
        this.patientBirthdate = getFieldValue(data, CONTACT_BIRTHDATE) || null;
        this.patientGender = getFieldValue(data, CONTACT_GENDER) || '';
        // The name is only trustworthy once it has come off the record, so this
        // is where it gets written down rather than in the change handler.
        this.persist();
    }

    handlePatientChange(event) {
        this.patientContactId = event.detail?.recordId || null;
        // Cleared whether or not an id arrived. The name still in memory
        // belongs to the previously selected patient, and storing it against a
        // newly chosen id would restore one patient's name beside another
        // patient's transcript after a reload. The wire above fills it back in
        // from the record a moment later.
        this.clearPatient();
        this.persist();
    }

    clearPatient() {
        this.patientName = '';
        this.patientBirthdate = null;
        this.patientGender = '';
    }

    /**
     * Age at today, not year subtraction — a birthday that has not come round
     * yet makes the difference between 27 and 28, and paediatric and geriatric
     * dosing both turn on the number being right.
     */
    get patientAge() {
        if (!this.patientBirthdate) {
            return '';
        }
        const born = new Date(this.patientBirthdate);
        if (isNaN(born.getTime())) {
            return '';
        }
        const now = new Date();
        let age = now.getFullYear() - born.getFullYear();
        const monthGap = now.getMonth() - born.getMonth();
        if (monthGap < 0 || (monthGap === 0 && now.getDate() < born.getDate())) {
            age--;
        }
        return age >= 0 ? String(age) : '';
    }

    /**
     * The initial only, the way a script is written. Anything that is not
     * plainly female or male is printed as the record holds it rather than
     * squeezed into a letter it does not fit.
     */
    get patientSex() {
        const g = (this.patientGender || '').trim();
        if (/^female$/i.test(g)) {
            return 'F';
        }
        if (/^male$/i.test(g)) {
            return 'M';
        }
        return g;
    }

    get patientAgeSex() {
        return [this.patientAge, this.patientSex].filter(Boolean).join(' / ');
    }

    /**
     * Weight is not on the Contact in this org, so it comes from the
     * consultation itself if anyone said it. Printed exactly as spoken, units
     * included or absent — appending "kg" to a bare number would be inventing
     * the one thing weight-based dosing depends on.
     */
    get patientWeight() {
        const hit = this.vitals.find((v) => /weight|wt\b|vazan/i.test(v.label));
        return hit ? hit.value : '';
    }

    /** Today, dd/mm/yyyy. The draft is written and signed on the same day. */
    get prescriptionDate() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    }

    /** The assessed problems, as the diagnosis line of a script. */
    get rxDiagnosis() {
        return this.assessment
            .map((a) => (a.hasStatus ? `${a.problem} (${a.statusLabel})` : a.problem))
            .join('; ');
    }

    get hasRxDiagnosis() {
        return !!this.rxDiagnosis;
    }

    // ------------------------------------------------------------------ getters

    get isIdle() {
        return this.state === 'idle' || this.state === 'error';
    }

    get isRecording() {
        return this.state === 'recording' || this.state === 'connecting';
    }

    get isBusy() {
        return this.state === 'connecting' || this.state === 'saving';
    }

    get statusLabel() {
        // Uploading is the slow half and it is silent, so it reports progress
        // rather than sitting on one word while a clinician wonders.
        if (this.state === 'transcribing' && this.uploadPercent > 0 && this.uploadPercent < 100) {
            return `Uploading ${this.uploadPercent}%`;
        }
        return {
            idle: 'Ready',
            connecting: 'Connecting',
            recording: 'Live',
            saving: 'Saving',
            transcribing: 'Transcribing',
            error: 'Error'
        }[this.state];
    }

    get elapsedLabel() {
        const total = Math.floor(this.elapsed);
        return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }

    get hasSegments() {
        return this.segments.length > 0;
    }

    get displaySegments() {
        const tones = {};
        let next = 1;
        return this.segments.map((s, i) => {
            if (!tones[s.speakerLabel]) {
                tones[s.speakerLabel] = ((next++ - 1) % 4) + 1;
            }
            const at = Math.floor(s.startSec);
            const low = s.confidence < LOW_CONFIDENCE;
            return {
                id: `${i}-${s.startSec}`,
                speaker: s.speakerLabel,
                initial: (s.speakerLabel || '?').trim().charAt(0).toUpperCase(),
                text: s.text,
                lowConfidence: low,
                provisional: !!s.provisional,
                timeLabel: `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`,
                cssClass:
                    `segment tone-${tones[s.speakerLabel]}` +
                    `${low ? ' segment_flagged' : ''}` +
                    `${s.provisional ? ' segment_provisional' : ''}`
            };
        });
    }

    /** The whole consultation as one document — the form the prompt template reads. */
    get conversationText() {
        return this.segments
            .map((s) => {
                const at = Math.floor(s.startSec);
                const stamp = `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
                return `[${stamp}] ${s.speakerLabel}: ${s.text}`;
            })
            .join('\n');
    }

    get hasTranscript() {
        return !!this.transcriptId;
    }

    /**
     * Whether the start-over control is offered.
     *
     * Withheld mid-consultation: this button discards a recording, and the
     * moment it would do the most damage is while one is still running. Also
     * withheld on an untouched console, where it has nothing to do and reads as
     * one more thing to wonder about.
     */
    get canStartOver() {
        if (this.state !== 'idle' && this.state !== 'error') {
            return false;
        }
        return (
            this.segments.length > 0 || !!this.transcriptId || !!this.patientContactId
        );
    }

    get canGenerate() {
        return this.hasTranscript && this.draftState !== 'loading';
    }

    get speakerCount() {
        return new Set(this.segments.map((s) => s.speakerLabel)).size;
    }

    /**
     * A dash until the recording closes, because until then there is no count
     * to report. Sarvam attributes speakers only across a whole recording, so
     * every live preview line carries the same placeholder label — counting
     * them announced "1 speaker" in a room of three, which is worse than
     * admitting the number is not known yet.
     */
    get hasAudioNotice() {
        return !!this.audioNotice;
    }

    get hasTranscriptionNotice() {
        return !!this.lastTranscriptionError;
    }

    /** One decimal place; a byte count means nothing to a clinician. */
    megabytes(bytes) {
        return (bytes / 1000000).toFixed(1);
    }

    get speakerCountLabel() {
        const stillRunning =
            this.state === 'connecting' ||
            this.state === 'recording' ||
            this.state === 'saving' ||
            this.state === 'transcribing';
        return stillRunning ? '—' : String(this.speakerCount);
    }

    /** The live strip is only honest once audio is actually being captured. */
    get isListening() {
        return this.state === 'recording';
    }

    get isConnecting() {
        return this.state === 'connecting';
    }

    /**
     * Sarvam diarizes only over a whole recording, so there is no word-by-word
     * stream to show any more. Saying "listening, words will appear here" would
     * be a promise this no longer keeps, so the strip reports what it can
     * honestly report: that audio is being captured, and when the words arrive.
     */
    get liveText() {
        return 'Recording. The transcript is produced when you stop, with each speaker separated.';
    }

    get liveTextClass() {
        return 'live__text live__text_idle';
    }

    get levelStyle() {
        return `width: ${this.level}%`;
    }

    /** Anything above this is real signal; below it the input is effectively dead. */
    get micIsSilent() {
        return this.sessionPeak < 0.005;
    }

    /**
     * Splits the two failure modes that both surface as an empty transcript.
     * Held back a few seconds so it does not accuse the microphone during the
     * moment before anyone has started speaking.
     */
    get liveHint() {
        if (this.elapsed < 5) {
            return '';
        }
        if (this.micIsSilent) {
            return 'No audio is reaching the recorder. Check the microphone input device, and that the browser tab and the OS are not muted.';
        }
        return '';
    }

    get hasLiveHint() {
        return !!this.liveHint;
    }

    /** The most recent turn, so the strip shows something once turns exist. */
    get lastSettled() {
        if (!this.segments.length) {
            return null;
        }
        const s = this.segments[this.segments.length - 1];
        return { speaker: s.speakerLabel, text: s.text };
    }

    get turnCount() {
        return this.segments.length;
    }

    // ------------------------------------------------------------------ actions

    async handleStart() {
        this.errorMessage = '';
        this.segments = [];
        this.elapsed = 0;
        this.closing = false;
        this.opened = false;
        this.level = 0;
        this.sessionPeak = 0;
        this.audioNotice = '';
        this.liveError = '';
        this.lastTranscriptionError = '';
        this.frameCount = 0;
        this.followLive = true;
        this.renderedTurnCount = 0;
        this.pcmChunks = [];
        this.pcmSamples = 0;
        this.captureRate = SAMPLE_RATE;
        this.uploadPercent = 0;
        this.liveChunkIndex = 0;
        this.liveBusy = false;
        this.liveSeconds = 0;
        this.state = 'connecting';

        // A new consultation is not the previous one's draft.
        this.transcriptId = null;
        this.transcriptName = '';
        this.draft = null;
        
        this.draftState = 'idle';
        this.draftError = '';

        try {
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            this.fail(`Microphone unavailable — ${err.name}: ${err.message}`);
            return;
        }

        try {
            const session = await startSession({ encounterId: this.recordId || null });
            this.sessionId = session.Id;
        } catch (err) {
            this.fail(this.messageFrom(err));
            this.releaseMic();
            return;
        }

        try {
            this.startAudioGraph();
        } catch (err) {
            // Reported rather than thrown. An exception escaping here leaves the
            // status on "Connecting" with the microphone open and the clinician
            // believing the consultation is being recorded, which is the single
            // worst way this component can fail.
            this.fail(`The audio pipeline would not start: ${err.message}`);
            this.releaseMic();
            return;
        }
        this.startTapeBackup();

        // Set here rather than from a socket opening. There is no handshake to
        // wait for any more: once the graph is running, audio is being kept.
        this.state = 'recording';

        // eslint-disable-next-line @lwc/lwc/no-async-operation
        this.tickId = setInterval(() => {
            this.elapsed += 0.25;
        }, 250);

        // eslint-disable-next-line @lwc/lwc/no-async-operation
        this.liveTimer = setInterval(() => this.flushLiveChunk(), LIVE_CHUNK_MS);
    }

    async handleStop() {
        const duration = this.elapsed;
        this.state = 'saving';
        clearInterval(this.tickId);
        clearInterval(this.liveTimer);
        this.closing = true;
        this.stopAudioGraph();

        // The mic is released first. Transcription takes seconds, and holding
        // the recording light on while nothing is being captured reads as though
        // the consultation is still being listened to.
        await this.stopTapeBackup();
        this.releaseMic();

        await this.transcribeRecording();

        // Filed after transcription because there is nothing to file before it,
        // and before endSession because the transcript is the deliverable.
        await this.fileTranscript();

        try {
            await endSession({ sessionId: this.sessionId, durationSec: duration });
        } catch (err) {
            // Closing the session record is bookkeeping. The audio, the turns
            // and the transcript are all already filed by this point.
            this.lastTranscriptionError = this.messageFrom(err);
        }
        this.state = 'idle';
    }

    /**
     * Sends the whole recording to Sarvam and turns the reply into turns.
     *
     * One request for the whole conversation, never a chunk at a time: speaker
     * identity is scoped to a single request, so "Speaker 0" in one chunk has no
     * relationship to "Speaker 0" in the next. Chunking is exactly what
     * scrambled speakers in the original design.
     *
     * The audio goes straight from the browser to the storage URL Sarvam issues.
     * Routing it through Apex would mean base64 in a callout body, and a
     * two-minute consultation is already around 3.8 MB raw, roughly 5.1 MB
     * encoded, against a 6 MB ceiling. That works today and breaks on a longer
     * visit.
     */
    async transcribeRecording() {
        if (!this.pcmSamples) {
            if (!this.errorMessage) {
                this.errorMessage = this.micIsSilent
                    ? 'No audio reached the recorder, the microphone captured silence. ' +
                      'Check the input device, and that the browser tab and the OS are not muted.'
                    : 'No audio was captured, so there is nothing to transcribe.';
            }
            return;
        }

        this.state = 'transcribing';
        try {
            const wav = this.buildWav();
            const job = await createJob({ languageCode: null, speakers: null });

            await this.uploadAudio(wav, job.uploadUrl);

            await startJob({ jobId: job.jobId });
            const utterances = await this.awaitTranscript(job.jobId);

            this.segments = utterances.map((u) => ({
                speakerLabel: u.speakerLabel || 'Speaker 0',
                startSec: u.startSec || 0,
                endSec: u.endSec || 0,
                text: u.text,
                // Sarvam reports no per-utterance confidence, so nothing is
                // flagged. Inventing a number would put a "review this" badge on
                // lines that nothing is actually wrong with.
                confidence: 1
            }));

            if (!this.segments.length) {
                this.lastTranscriptionError = this.noSpeechReason();
            }

            // The turns are the thing a reload has to bring back, so they are
            // written the moment they exist rather than waiting on filing.
            this.persist();
        } catch (err) {
            // Apex already prefixes its own failures, so this no longer adds a
            // second "Transcription failed:" in front of the one it sent.
            this.lastTranscriptionError = this.messageFrom(err);
        }
    }

    /**
     * Why an empty transcript came back, said as precisely as the evidence
     * allows.
     *
     * Three different faults used to share one sentence: a recording too short
     * to contain a sentence, a microphone that captured nothing, and audio that
     * was genuinely fine but held no speech Sarvam could place. They need
     * different actions, so they get different messages — and each carries the
     * numbers behind it, because "too quiet" is a guess and "peak level 0.0009
     * over 42s" is a fact the next person can check.
     */
    noSpeechReason() {
        const seconds = Math.round(this.elapsed);
        const peak = this.sessionPeak.toFixed(4);
        const rate = this.captureRate;
        const kb = Math.round((44 + this.pcmSamples * BYTES_PER_SAMPLE) / 1024);
        const evidence =
            `Recording ${seconds}s, peak input level ${peak}, captured at ${rate} Hz, ${kb} KB sent.`;

        // The rate the graph actually ran at, not the rate that was asked for.
        // Sarvam takes 8 kHz or 16 kHz and nothing else; hand it 44.1 or 48 and
        // an empty transcript is a plausible reply, which is indistinguishable
        // from a room nobody spoke in unless the number is on screen.
        if (rate !== SAMPLE_RATE && rate !== 8000) {
            return (
                `The audio was captured at ${rate} Hz, but the transcription service accepts only ` +
                `8000 Hz or 16000 Hz. This browser refused the requested ${SAMPLE_RATE} Hz capture ` +
                `rate, so the recording was sent at a rate the model cannot read. ${evidence}`
            );
        }

        // Healthy audio that transcribes to nothing on both the live endpoint
        // and the batch job is not an audio problem. Said first, because it
        // sends the reader to the credential rather than to the microphone.
        if (!this.micIsSilent && seconds >= MIN_USEFUL_SECONDS && this.liveError) {
            return (
                `Audio was captured, but the transcription service returned nothing and the live ` +
                `preview was failing during the recording: "${this.liveError}". ${evidence} ` +
                `The audio is fine, so check the Sarvam API key and the account's remaining quota.`
            );
        }

        if (this.micIsSilent) {
            return (
                `The microphone captured effectively nothing, so there was no speech to find. ${evidence} ` +
                `Check that the right input device is selected, and that neither the browser tab nor the ` +
                `operating system has the microphone muted.`
            );
        }
        if (seconds < MIN_USEFUL_SECONDS) {
            return (
                `The recording was only ${seconds}s long, which is usually too short for Sarvam to place ` +
                `any speech. ${evidence} Record for at least ${MIN_USEFUL_SECONDS}s and try again.`
            );
        }
        return (
            `Audio was captured, but Sarvam found no speech in it. ${evidence} ` +
            `Most often the speakers are too far from the microphone, or the conversation is in a ` +
            `language the model does not cover.`
        );
    }

    /**
     * Sends the recording to storage a block at a time, through Apex.
     *
     * It cannot go directly. Sarvam's storage account publishes no CORS rules,
     * so the browser's preflight for a cross-origin PUT is refused outright and
     * fetch reports only "Failed to fetch" — no status, no body, nothing that
     * names the cause. Apex is not subject to CORS, so the bytes go that way.
     *
     * Blocks rather than one body because Apex holds the base64 and the decoded
     * audio together, and a whole consultation would not fit under the heap
     * limit. Azure stages each block and assembles them on commit.
     */
    async uploadAudio(wav, uploadUrl) {
        const total = Math.ceil(wav.size / UPLOAD_BLOCK_BYTES);

        for (let i = 0; i < total; i++) {
            const slice = wav.slice(i * UPLOAD_BLOCK_BYTES, (i + 1) * UPLOAD_BLOCK_BYTES);
            // Sequential on purpose. In parallel these would race for the same
            // Apex heap and gain nothing: the upload is bounded by Salesforce's
            // request handling, not by how many are in flight.
            await uploadBlock({
                uploadUrl: uploadUrl,
                index: i,
                audioBase64: await this.toBase64(slice)
            });
            this.uploadPercent = Math.round(((i + 1) / total) * 100);
        }

        // Until this lands the blocks are staged and the blob does not exist, so
        // a job started before it transcribes silence rather than failing.
        await commitBlocks({ uploadUrl: uploadUrl, count: total });
    }

    /**
     * Transcribes the speech captured since the last pass and shows it now.
     *
     * The words appear while the consultation is still going; the speakers do
     * not. Sarvam attributes speakers only across a whole recording, so these
     * lines are provisional and get replaced wholesale by the diarized version
     * once recording stops. Showing them unattributed is honest — inventing a
     * speaker here and correcting it later would be worse than leaving it blank.
     *
     * Every failure is swallowed. This is a preview of a recording that is still
     * being made, and nothing it does is allowed to disturb the recording or the
     * final transcript.
     */
    async flushLiveChunk() {
        // A slow round trip must not stack up passes, or two of them would send
        // overlapping audio and the preview would stutter and repeat.
        if (this.liveBusy || this.closing) {
            return;
        }

        const pending = this.pcmChunks.slice(this.liveChunkIndex);
        const samples = pending.reduce((n, c) => n + c.length, 0);
        if (samples < LIVE_MIN_SAMPLES) {
            return;
        }

        this.liveBusy = true;
        const startedAt = this.liveSeconds;
        const upTo = this.pcmChunks.length;

        try {
            const wav = this.buildWav(pending, samples, true);
            const text = await transcribeChunk({ audioBase64: await this.toBase64(wav) });

            if (text && text.trim()) {
                this.segments = [
                    ...this.segments,
                    {
                        speakerLabel: 'Speaker',
                        startSec: startedAt,
                        endSec: this.elapsed,
                        text: text.trim(),
                        confidence: 1,
                        provisional: true
                    }
                ];
            }
            this.liveChunkIndex = upTo;
            this.liveSeconds = this.elapsed;
        } catch (err) {
            // Still silent to the clinician mid-consultation: the audio is being
            // kept and the real transcript comes from the whole recording. But
            // the reason is remembered now rather than discarded. When the batch
            // job also comes back empty, this is the line that says whether the
            // service was refusing the request all along — swallowing it cost a
            // diagnosis that was sitting right here.
            this.liveError = this.messageFrom(err);
            this.liveChunkIndex = upTo;
        } finally {
            this.liveBusy = false;
        }
    }

    /** Blob to base64, without the data: prefix FileReader insists on adding. */
    toBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result || '';
                const comma = result.indexOf(',');
                resolve(comma >= 0 ? result.slice(comma + 1) : result);
            };
            reader.onerror = () => reject(new Error('The recording could not be read for upload.'));
            reader.readAsDataURL(blob);
        });
    }

    /** Polls until the job settles, or gives up loudly rather than hanging. */
    async awaitTranscript(jobId) {
        const deadline = Date.now() + POLL_TIMEOUT_MS;

        for (;;) {
            const result = await pollJob({ jobId: jobId, sessionId: this.sessionId });
            if (result.error) {
                throw new Error(result.error);
            }
            if (result.isDone) {
                return result.utterances || [];
            }
            if (Date.now() > deadline) {
                const state = (result.state || 'working').toLowerCase();
                throw new Error(
                    'Sarvam was still ' + state + ' after ' +
                    Math.round(POLL_TIMEOUT_MS / 1000) + 's. The recording is saved.'
                );
            }
            await this.pause(POLL_INTERVAL_MS);
        }
    }

    pause(ms) {
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Wraps the kept PCM in a 44-byte WAV header.
     *
     * Sarvam takes WAV or raw PCM, and WAV wins because the header carries the
     * sample rate with it. Raw PCM needs the rate declared separately, and a
     * mismatch there does not fail loudly, it just transcribes a chipmunk.
     */
    buildWav(chunks, sampleCount, padForBase64) {
        const source = chunks || this.pcmChunks;
        const count = sampleCount === undefined ? this.pcmSamples : sampleCount;
        const bytes = count * BYTES_PER_SAMPLE;

        // Apex builds its multipart body by concatenating three base64 strings,
        // and that only decodes back to the original bytes if every segment but
        // the last is a whole number of 3-byte groups. Padding here, with bytes
        // that sit past the length the WAV header declares, is cheaper than
        // making Apex re-encode the audio. Decoders read the declared length and
        // never see them.
        const tail = padForBase64 ? (3 - ((44 + bytes) % 3)) % 3 : 0;
        const buffer = new ArrayBuffer(44 + bytes + tail);
        const view = new DataView(buffer);
        const rate = this.captureRate;

        const ascii = (offset, text) => {
            for (let i = 0; i < text.length; i++) {
                view.setUint8(offset + i, text.charCodeAt(i));
            }
        };

        ascii(0, 'RIFF');
        view.setUint32(4, 36 + bytes, true);
        ascii(8, 'WAVE');
        ascii(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, rate, true);
        view.setUint32(28, rate * BYTES_PER_SAMPLE, true);
        view.setUint16(32, BYTES_PER_SAMPLE, true);
        view.setUint16(34, 8 * BYTES_PER_SAMPLE, true);
        ascii(36, 'data');
        view.setUint32(40, bytes, true);

        let at = 44;
        for (const chunk of source) {
            for (let i = 0; i < chunk.length; i++) {
                view.setInt16(at, chunk[i], true);
                at += BYTES_PER_SAMPLE;
            }
        }

        // Cheap, and it catches the one bug this writer is prone to. A chunk
        // that is not an indexable typed array silently contributes nothing,
        // leaving a correctly sized file full of zeros that uploads fine and
        // transcribes to nothing. Better to fail here, naming the cause.
        if (at !== 44 + bytes) {
            throw new Error(
                `Audio assembly wrote ${at - 44} of ${bytes} expected bytes. ` +
                `The recording would have been silent.`
            );
        }
        return new Blob([buffer], { type: 'audio/wav' });
    }

    /**
     * Files the conversation as one document.
     *
     * Composed here rather than rebuilt server-side from Transcript_Segment__c
     * because the final flush and this call race — segments written seconds ago
     * may not be queryable yet, and a draft built from a truncated consultation
     * is worse than no draft.
     */
    async fileTranscript() {
        if (!this.segments.length) {
            // Held, not shown, like the transcription failure it follows. This
            // used to be masked by that failure's own message; suppressing that
            // one is what let this through, and it belongs on the same channel.
            if (!this.lastTranscriptionError) {
                this.lastTranscriptionError =
                    'Nothing was transcribed, so no consultation record was created.';
            }
            return;
        }
        try {
            const record = await saveTranscript({ conversation: this.conversationText });
            this.transcriptId = record.Id;
            this.transcriptName = record.Name;
            this.persist();
        } catch (err) {
            // The transcript rows are already saved, so this is recoverable —
            // it costs the draft, not the consultation.
            this.lastTranscriptionError = `Consultation record not created: ${this.messageFrom(err)}`;
        }
    }

    /**
     * Opens the draft, generating one only where there is not one already.
     *
     * The guard matters more than it looks. Filing is part of generating, so a
     * second run does not replace the first prescription — it files another one
     * against the same consultation, leaving the clinician two Draft
     * prescriptions for one patient with nothing to say which is current.
     * Before this console survived a reload that took a deliberate second
     * press; now that a restored draft sits behind this same button, it would
     * be the ordinary consequence of pressing it once.
     */
    async handleGenerateDraft() {
        if (this.draftState === 'ready' && this.draft) {
            this.showDraft = true;
            return;
        }

        this.showDraft = true;
        this.draftState = 'loading';
        this.draftError = '';
        this.draft = null;
        // Cleared up front: otherwise a call that fails before a reply arrives
        // would show the previous run's response underneath the new error.
        this.rawDraft = '';
        this.prescriptionName = '';
        this.prescriptionError = '';
        this.pdfError = '';
        // A new consultation's rows are not the previous one's, and the item
        // ids from the last filing point at another patient's prescription.
        this.prescriptionItemIds = [];
        this.rxEdits = [];
        this.rxDxEdits = [];
        this.rxInvEdits = [];
        this.isEditingRx = false;
        this.rxEditError = '';

        let raw;
        try {
            raw = await generateDraft({ transcriptId: this.transcriptId });
        } catch (err) {
            this.draftState = 'error';
            this.draftError = this.messageFrom(err);
            return;
        }

        this.rawDraft = raw;
        try {
            this.draft = JSON.parse(raw);
            this.draftState = 'ready';
            this.persist();
        } catch (err) {
            // Kept separate from a call failure: the model answered, it just did
            // not answer in JSON, and the raw text is still worth showing.
            this.draftState = 'error';
            this.draftError = 'The model did not return valid JSON. The raw response is below.';
            return;
        }

        await this.fileDraftPrescription(raw);
    }

    /**
     * Files the draft as a Draft prescription: the SOAP sections into their own
     * fields, the medication list into Prescription Description.
     *
     * Deliberately after the draft is already on screen. Filing is the slower
     * half and the clinician has nothing to wait for — and if it fails, the
     * draft they are reading is still valid, so the failure is reported beside
     * it rather than replacing it.
     *
     * The patient is whoever the clinician picked, and only that. If they picked
     * nobody the field is left unset rather than inferred from the transcript —
     * filing a prescription against the wrong person is worse than filing it
     * against no-one, which a clinician can still correct on the record.
     */
    async fileDraftPrescription(raw) {
        try {
            const result = await createFromDraft({
                transcriptId: this.transcriptId,
                draftJson: raw,
                patientContactId: this.patientContactId
            });
            this.prescriptionName = result?.prescription?.Name || '';
            this.prescriptionId = result?.prescription?.Id || '';
            // Kept so corrections can reach the record. Filing is what creates
            // the rows, so without these ids there is nothing to edit into.
            this.prescriptionItemIds = (result?.items || []).map((i) => i.Id).filter(Boolean);
            this.persist();
        } catch (err) {
            this.prescriptionError = this.messageFrom(err);
        }
    }

    get hasPrescriptionError() {
        return !!this.prescriptionError;
    }

    handleCloseDraft() {
        this.showDraft = false;
    }

    /**
     * Clears the console back to the state it opens in, ready for the next
     * patient. The same thing a page refresh does, without leaving the page.
     *
     * Safe to lose everything held here: by the time this button can be
     * reached, the transcript, the draft and the prescription have all been
     * filed server-side, so nothing on screen is the only copy of anything.
     *
     * The ids are dropped rather than carried over. Reusing transcriptId or
     * prescriptionId across two consultations would file one patient's
     * medications onto another patient's record, which is the worst thing this
     * button could quietly do.
     */
    handleStartOver() {
        this.teardown();
        clearInterval(this.liveTimer);
        clearInterval(this.saveTimer);
        this.recorder = null;

        // Capture
        this.segments = [];
        this.state = 'idle';
        this.elapsed = 0;
        this.errorMessage = '';
        this.sessionId = null;
        this.recordedParts = [];
        this.pcmChunks = [];
        this.pcmSamples = 0;
        this.captureRate = SAMPLE_RATE;
        this.uploadPercent = 0;
        this.liveTimer = null;
        this.liveChunkIndex = 0;
        this.liveBusy = false;
        this.liveSeconds = 0;
        this.saveTimer = null;
        this.tickId = null;
        this.closing = false;
        this.opened = false;
        this.level = 0;
        this.sessionPeak = 0;
        this.frameCount = 0;
        this.audioNotice = '';
        this.liveError = '';
        this.lastTranscriptionError = '';
        this.followLive = true;
        this.renderedTurnCount = 0;

        // The filed consultation, and everything drafted from it
        this.transcriptId = null;
        this.transcriptName = '';
        this.draft = null;
        this.draftState = 'idle';
        this.draftError = '';
        this.rawDraft = '';
        this.showDraft = false;
        this.prescriptionName = '';
        this.prescriptionError = '';
        this.prescriptionId = '';
        this.prescriptionItemIds = [];
        this.pdfBusy = false;
        this.pdfError = '';

        // Medication corrections
        this.rxEdits = [];
        this.rxDxEdits = [];
        this.rxInvEdits = [];
        this.isEditingRx = false;
        this.rxSaving = false;
        this.rxEditError = '';
        this.invKeySeed = 0;

        // Evidence is on when the card first opens, so it is on again here.
        this.showEvidence = true;

        // The next consultation is a different patient more often than not, so
        // the picker is emptied rather than left holding the last one. Clearing
        // the id alone leaves the chosen name sitting in the input, so the
        // component is told directly as well.
        this.patientContactId = null;
        this.clearPatient();
        const picker = this.template.querySelector('lightning-record-picker');
        if (picker && typeof picker.clearSelection === 'function') {
            picker.clearSelection();
        }

        // Last, and only here. This button is the one thing that discards a
        // consultation, so it is also the one thing that empties the store — a
        // reload has to bring the transcript back, and this has to be what
        // stops it doing so.
        this.clearPersisted();
    }

    // ------------------------------------------------------------- persistence

    /** Scoped to the host record so two encounters cannot read each other's. */
    get storageKey() {
        return `${STORE_PREFIX}:${this.recordId || 'standalone'}`;
    }

    /**
     * The backing store, or null where the browser refuses it.
     *
     * Named explicitly rather than looked up as window[STORE]: Lightning Web
     * Security hands the component a proxied window, and computed access to it
     * is the kind of thing that works until it does not.
     */
    get store() {
        try {
            return STORE === 'localStorage' ? window.localStorage : window.sessionStorage;
        } catch (err) {
            // Blocked by browser settings. Persistence is a convenience here,
            // so losing it is not worth a message on a clinical screen.
            return null;
        }
    }

    /**
     * Writes what a reload needs to redraw the same screen.
     *
     * The outcome of a consultation only: the turns, the filed ids, the draft.
     * Nothing from live capture, because none of it survives a page unload
     * anyway — pcmChunks holds megabytes of audio that would blow the storage
     * quota on its own, and the audio graph it feeds is gone. A restored
     * console is therefore always an idle one.
     */
    persist() {
        const store = this.store;
        if (!store) {
            return;
        }
        try {
            store.setItem(
                this.storageKey,
                JSON.stringify({
                    segments: this.segments,
                    elapsed: this.elapsed,
                    transcriptId: this.transcriptId,
                    transcriptName: this.transcriptName,
                    patientContactId: this.patientContactId,
                    patientName: this.patientName,
                    patientBirthdate: this.patientBirthdate,
                    patientGender: this.patientGender,
                    draft: this.draft,
                    rawDraft: this.rawDraft,
                    // A draft that was mid-flight when the page went away did
                    // not finish, and there is no request left to wait for.
                    draftState: this.draftState === 'ready' ? 'ready' : 'idle',
                    prescriptionName: this.prescriptionName,
                    prescriptionId: this.prescriptionId,
                    prescriptionItemIds: this.prescriptionItemIds,
                    showEvidence: this.showEvidence,
                    audioNotice: this.audioNotice,
                    lastTranscriptionError: this.lastTranscriptionError
                })
            );
        } catch (err) {
            // Quota exceeded, or storage disabled mid-session. The consultation
            // is filed server-side either way, so this costs the reload
            // behaviour and nothing clinical.
        }
    }

    /**
     * Redraws the last consultation after a reload.
     *
     * Every field is defaulted rather than trusted. This JSON was written by an
     * older build of this component as easily as the current one, and a shape
     * that has since changed should degrade to an empty console rather than
     * render half a consultation.
     */
    restore() {
        const store = this.store;
        if (!store) {
            return;
        }

        let saved;
        try {
            const raw = store.getItem(this.storageKey);
            if (!raw) {
                return;
            }
            saved = JSON.parse(raw);
        } catch (err) {
            // Unreadable or not JSON. Treated as nothing kept.
            return;
        }
        if (!saved || typeof saved !== 'object') {
            return;
        }

        this.segments = Array.isArray(saved.segments) ? saved.segments : [];
        this.elapsed = Number(saved.elapsed) || 0;
        this.transcriptId = saved.transcriptId || null;
        this.transcriptName = saved.transcriptName || '';
        this.patientContactId = saved.patientContactId || null;
        // Written back so the name is on screen with the first paint. The
        // wired record refreshes it a moment later from the record itself,
        // which is the copy that counts.
        this.patientName = saved.patientName || '';
        this.patientBirthdate = saved.patientBirthdate || null;
        this.patientGender = saved.patientGender || '';
        this.draft = saved.draft || null;
        this.rawDraft = saved.rawDraft || '';
        this.draftState = saved.draftState === 'ready' ? 'ready' : 'idle';
        this.prescriptionName = saved.prescriptionName || '';
        this.prescriptionId = saved.prescriptionId || '';
        this.prescriptionItemIds = Array.isArray(saved.prescriptionItemIds)
            ? saved.prescriptionItemIds
            : [];
        this.showEvidence = saved.showEvidence !== false;
        this.audioNotice = saved.audioNotice || '';
        this.lastTranscriptionError = saved.lastTranscriptionError || '';

        // The recording does not come back, whatever it was doing when the page
        // went away, so the console opens idle. The draft is left closed on
        // purpose: throwing up a modal nobody asked for on a screen they have
        // just loaded is startling, and the button to reopen it is right there.
        this.state = 'idle';
        this.showDraft = false;
    }

    /** Forgets the kept consultation, so the next load opens empty. */
    clearPersisted() {
        const store = this.store;
        if (!store) {
            return;
        }
        try {
            store.removeItem(this.storageKey);
        } catch (err) {
            // Nothing to do: the in-memory reset has already happened, so the
            // screen is correct even if the store could not be emptied.
        }
    }

    handleModalKeydown(event) {
        if (event.key === 'Escape') {
            this.handleCloseDraft();
        }
    }

    /** Stops a click inside the panel from reaching the backdrop's close handler. */
    stopPropagation(event) {
        event.stopPropagation();
    }

    // ------------------------------------------------------- draft view getters

    get isDraftLoading() {
        return this.draftState === 'loading';
    }

    get isDraftReady() {
        return this.draftState === 'ready' && !!this.draft;
    }

    get isDraftError() {
        return this.draftState === 'error';
    }

    get generateLabel() {
        if (this.draftState === 'loading') {
            return 'Generating…';
        }
        // Says what pressing it will actually do. Offering "Generate Draft"
        // over a draft that already exists is what invites the second filing.
        return this.draftState === 'ready' && this.draft ? 'View Draft' : 'Generate Draft';
    }

    /** Shown only when the reply could not be parsed, so the error is not a dead end. */
    get hasUnparsedResponse() {
        return this.draftState === 'error' && !!this.rawDraft;
    }

    // The draft is a SOAP note plus a prescription list. Every item carries the
    // transcript quote that produced it, which is what makes the note reviewable
    // instead of something the clinician has to re-derive from memory.

    get subjective() {
        return this.draft?.subjective || {};
    }

    get chiefComplaint() {
        return this.subjective.chiefComplaint || '';
    }

    get subjectiveNarrative() {
        return this.subjective.narrative || '';
    }

    get pertinentNegatives() {
        return this.withEvidence(this.subjective.pertinentNegatives, 'neg', (r) => ({
            text: r.finding || '—'
        }));
    }

    get objective() {
        return this.draft?.objective || {};
    }

    get vitals() {
        return this.withEvidence(this.objective.vitals, 'vit', (r) => ({
            label: r.label || '—',
            value: r.value || '',
            context: r.context || ''
        }));
    }

    get examFindings() {
        return this.withEvidence(this.objective.examFindings, 'exam', (r) => ({
            text: r.finding || '—',
            uncertain: r.uncertain || ''
        }));
    }

    get functionalStatus() {
        return this.withEvidence(this.objective.functionalStatus, 'func', (r) => ({
            text: r.finding || '—'
        }));
    }

    get assessment() {
        return this.withEvidence(this.draft?.assessment, 'dx', (r) => {
            const status = (r.status || '').toLowerCase();
            return {
                problem: r.problem || '—',
                reasoning: r.reasoning || '',
                statusLabel: status ? status.charAt(0).toUpperCase() + status.slice(1) : '',
                hasStatus: !!status
            };
        });
    }

    get plan() {
        return this.draft?.plan || {};
    }

    get planActions() {
        return this.withEvidence(this.plan.actions, 'act', (r) => ({ text: r.action || '—' }));
    }

    get investigations() {
        return this.withEvidence(this.plan.investigations, 'inv', (r) => ({
            name: r.name || '—',
            timing: r.timing || ''
        }));
    }

    get patientInstructions() {
        return this.withEvidence(this.plan.patientInstructions, 'ins', (r) => ({
            text: r.instruction || '—'
        }));
    }

    get followUpText() {
        return this.plan.followUp?.text || '';
    }

    get followUpQuote() {
        const ev = this.evidenceOf(this.plan.followUp);
        if (!this.showEvidence || !ev.hasEvidence) {
            return null;
        }
        // evidenceOf already resolved display and isTranslated, so this one
        // needs nothing added — it just has to stop adding its own flag.
        return ev;
    }

    /**
     * The card reads the way a clinician reads a script: the drug, its dose,
     * when to take it, how often, for how long. Form, route and quantity are
     * still filed on the Prescription record itself; they are just not what a
     * reviewer needs on the card. "Her blood thinner" is a question, not an
     * order, and must not look like one, so a field nobody spoke is absent
     * rather than filled with a placeholder.
     */
    get prescription() {
        return this.withEvidence(this.draft?.prescription, 'rx', (r, i) => {
            const status = (r.status || 'new').toLowerCase();
            // Dose and route read as one instruction on a script — "1 tab PO" —
            // so they share a column rather than each holding a near-empty one.
            const doseRoute = [this.spoken(r.form), this.spoken(r.route)]
                .filter(Boolean)
                .join(' ');
            return {
                drug: this.spoken(r.drug) || 'Not named',
                strength: this.spoken(r.strength) || '—',
                doseRoute: doseRoute || '—',
                frequency: this.spoken(r.frequency) || '—',
                timing: this.spoken(r.timing),
                duration: this.spoken(r.duration) || '—',
                indication: this.spoken(r.indication),
                isPrn: r.prn === true,
                note: r.note || '',
                uncertain: r.uncertain || '',
                replaces: this.spoken(r.replaces),
                // Labelled only where the label earns its place. Nearly every
                // row is "new", so printing it beside every drug name said
                // nothing; a withdrawn or altered order has to be seen.
                showStatus: status === 'changed' || status === 'stopped',
                statusLabel: status.charAt(0).toUpperCase() + status.slice(1),
                // A withdrawn drug is ruled through in the table as well as
                // badged. On a sheet that reads like an order, a badge alone is
                // too easy to skim past.
                rowClass: `rxrow rxrow_${status}`,
                badgeClass: `badge badge_${status}`
            };
        });
    }

    // -------------------------------------------------------- correcting the rx

    /**
     * Which filed row belongs to which draft row.
     *
     * Mirrors PrescriptionController.buildItems, which skips a row with no drug
     * name and a row the clinician withdrew, in that order — so the nth item
     * filed is the nth draft row that survived both rules. Deliberately
     * explicit: if that Apex ever changes what it files, this is the thing that
     * has to change with it.
     */
    get itemIdByDraftIndex() {
        const map = {};
        let filed = 0;
        this.asArray(this.draft?.prescription).forEach((r, i) => {
            const drug = this.spoken(r?.drug);
            const status = (r?.status || '').toLowerCase();
            if (!drug || status === 'stopped') {
                return;
            }
            if (this.prescriptionItemIds[filed]) {
                map[i] = this.prescriptionItemIds[filed];
            }
            filed++;
        });
        return map;
    }

    get canEditRx() {
        return this.prescriptionItemIds.length > 0;
    }

    /** Says why rather than presenting a button that could not do anything. */
    get rxEditHint() {
        if (this.canEditRx) {
            return '';
        }
        return this.prescriptionError
            ? 'These rows cannot be corrected because filing the prescription failed.'
            : 'These rows can be corrected once the prescription has been filed.';
    }

    get rxSaveLabel() {
        return this.rxSaving ? 'Saving…' : 'Save corrections';
    }

    get hasRxEditError() {
        return !!this.rxEditError;
    }

    get hasDxEdits() {
        return this.rxDxEdits.length > 0;
    }

    /** LWC has no negated conditional, and the read-only sheet needs one. */
    get isViewingRx() {
        return !this.isEditingRx;
    }

    handleEditRx() {
        const idByIndex = this.itemIdByDraftIndex;
        this.rxEditError = '';

        // One field per assessment entry rather than one box for the joined
        // line. The sheet shows them joined with "; ", but collapsing them into
        // a single string to edit would lose which problem each status and
        // evidence quote belongs to, and there is no putting that back.
        this.rxDxEdits = this.asArray(this.draft?.assessment).map((a, i) => {
            const status = (a?.status || '').toLowerCase();
            return {
                key: `dx-${i}`,
                index: i,
                problem: a?.problem || '',
                statusLabel: status ? status.charAt(0).toUpperCase() + status.slice(1) : ''
            };
        });

        // originalIndex is what keeps each row tied to the drafted investigation
        // it came from. Position in this list is not enough: remove one row and
        // every row after it would inherit the wrong evidence quote.
        this.rxInvEdits = this.asArray(this.draft?.plan?.investigations).map((t, i) => ({
            key: `inv-${i}`,
            originalIndex: i,
            name: t?.name || '',
            timing: t?.timing || ''
        }));
        this.invKeySeed = this.rxInvEdits.length;
        this.rxEdits = this.asArray(this.draft?.prescription).map((r, i) => {
            const itemId = idByIndex[i] || '';
            return {
                key: `edit-${i}`,
                draftIndex: i,
                itemId,
                editable: !!itemId,
                drug: this.spoken(r?.drug) || 'Not named',
                medication: this.spoken(r?.drug),
                strength: this.spoken(r?.strength),
                doseRoute: [this.spoken(r?.form), this.spoken(r?.route)].filter(Boolean).join(' '),
                frequency: this.spoken(r?.frequency),
                duration: this.spoken(r?.duration),
                // Withdrawn drugs have no filed row on purpose, and an editable
                // dose is the first step to turning a retraction into an order.
                lockedReason: itemId ? '' : 'withdrawn during the consultation — not an order'
            };
        });
        this.isEditingRx = true;
    }

    handleCancelRxEdit() {
        this.isEditingRx = false;
        this.rxEdits = [];
        this.rxDxEdits = [];
        this.rxInvEdits = [];
        this.rxEditError = '';
    }

    handleDxChange(event) {
        const index = Number(event.target.dataset.index);
        const value = event.target.value;
        this.rxDxEdits = this.rxDxEdits.map((d) =>
            d.index === index ? { ...d, problem: value } : d
        );
    }

    handleInvChange(event) {
        const key = event.target.dataset.key;
        const field = event.target.dataset.field;
        const value = event.target.value;
        this.rxInvEdits = this.rxInvEdits.map((t) =>
            t.key === key ? { ...t, [field]: value } : t
        );
    }

    handleAddInvestigation() {
        this.invKeySeed += 1;
        this.rxInvEdits = [
            ...this.rxInvEdits,
            { key: `inv-new-${this.invKeySeed}`, originalIndex: -1, name: '', timing: '' }
        ];
    }

    /**
     * Removes the row outright rather than blanking it. A test the clinician
     * decided against should leave no trace on the sheet, and an empty row that
     * still occupies a line reads as one they forgot to fill in.
     */
    handleRemoveInvestigation(event) {
        const key = event.target.dataset.key;
        this.rxInvEdits = this.rxInvEdits.filter((t) => t.key !== key);
    }

    handleRxFieldChange(event) {
        const index = Number(event.target.dataset.index);
        const field = event.target.dataset.field;
        const value = event.target.value;
        this.rxEdits = this.rxEdits.map((row) =>
            row.draftIndex === index ? { ...row, [field]: value } : row
        );
    }

    /**
     * Writes the corrections to the record, then back into the draft.
     *
     * Both, not either. The record is what the org keeps and the draft is what
     * the sheet and the PDF are rendered from, so correcting only one of them
     * would hand the patient a document that disagrees with their chart.
     */
    async handleSaveRx() {
        if (this.rxSaving) {
            return;
        }
        const rows = this.rxEdits.filter((r) => r.editable);
        const blank = rows.find((r) => !(r.medication || '').trim());
        if (blank) {
            this.rxEditError = 'A medication cannot be saved without a name.';
            return;
        }
        const namelessDx = this.rxDxEdits.find((d) => !(d.problem || '').trim());
        if (namelessDx) {
            this.rxEditError = 'A diagnosis cannot be left blank. Correct the wording instead.';
            return;
        }
        // A timing with no test attached is an instruction about nothing.
        const orphanTiming = this.rxInvEdits.find(
            (t) => !(t.name || '').trim() && (t.timing || '').trim()
        );
        if (orphanTiming) {
            this.rxEditError = 'An investigation needs a name before it can have a timing.';
            return;
        }

        this.rxEditError = '';
        this.rxSaving = true;
        try {
            await savePrescriptionEdits({
                prescriptionId: this.prescriptionId,
                rowsJson: JSON.stringify(
                    rows.map((r) => ({
                        itemId: r.itemId,
                        medication: r.medication,
                        strength: r.strength,
                        doseRoute: r.doseRoute,
                        frequency: r.frequency,
                        duration: r.duration
                    }))
                ),
                diagnosesJson: JSON.stringify(this.rxDxEdits.map((d) => d.problem)),
                investigationsJson: JSON.stringify(
                    this.rxInvEdits
                        .filter((t) => (t.name || '').trim())
                        .map((t) => ({ name: t.name, timing: t.timing }))
                )
            });
            this.applyRxEditsToDraft(rows);
            this.applyHeaderEditsToDraft();
            this.rawDraft = JSON.stringify(this.draft);
            this.isEditingRx = false;
            this.rxEdits = [];
            this.rxDxEdits = [];
            this.rxInvEdits = [];
        } catch (err) {
            this.rxEditError = `The corrections could not be saved: ${this.messageFrom(err)}`;
        } finally {
            this.rxSaving = false;
        }
    }

    /**
     * Writes the corrected diagnosis and investigations back into the draft, so
     * the sheet and the PDF show what the clinician decided.
     *
     * Only the problem text is replaced on an assessment entry. Its status,
     * reasoning and evidence quote are left exactly as drafted — those describe
     * how the model reached the line, and editing the line does not rewrite its
     * history.
     */
    applyHeaderEditsToDraft() {
        const dxByIndex = new Map(this.rxDxEdits.map((d) => [d.index, d.problem]));
        const assessment = this.asArray(this.draft?.assessment).map((a, i) =>
            dxByIndex.has(i) ? { ...a, problem: dxByIndex.get(i) } : a
        );

        const original = this.asArray(this.draft?.plan?.investigations);
        const investigations = this.rxInvEdits
            .filter((t) => (t.name || '').trim())
            .map((t) => {
                // Carries the quote of the investigation this row actually came
                // from. An added row cites nothing, and says so by having no
                // evidence rather than borrowing the quote of a neighbour.
                const from = t.originalIndex >= 0 ? original[t.originalIndex] : null;
                return { ...(from || {}), name: t.name, timing: t.timing };
            });

        this.draft = {
            ...this.draft,
            assessment,
            plan: { ...(this.draft?.plan || {}), investigations }
        };
    }

    /**
     * The edited value replaces "form" and "route" with the single string that
     * was typed, because "1 tab PO" is what the clinician entered and splitting
     * it back into two fields would be guessing where the boundary was.
     *
     * rawDraft is rebuilt too: it is what the PDF is generated from.
     */
    applyRxEditsToDraft(rows) {
        const byIndex = new Map(rows.map((r) => [r.draftIndex, r]));
        const next = this.asArray(this.draft?.prescription).map((original, i) => {
            const edit = byIndex.get(i);
            if (!edit) {
                return original;
            }
            return {
                ...original,
                drug: edit.medication,
                strength: edit.strength,
                form: '',
                route: edit.doseRoute,
                frequency: edit.frequency,
                duration: edit.duration
            };
        });
        this.draft = { ...this.draft, prescription: next };
        this.rawDraft = JSON.stringify(this.draft);
    }

    /**
     * A value nobody spoke. The prompt is told to leave those fields empty,
     * but a model that answers "unknown" instead would have it rendered as
     * though it were a dose, so the placeholder is dropped here as well.
     */
    spoken(value) {
        const text = typeof value === 'string' ? value.trim() : '';
        return /^(unknown|not specified|not stated|not mentioned|n\/?a|none|null)$/i.test(text)
            ? ''
            : text;
    }

    get hasPertinentNegatives() {
        return this.pertinentNegatives.length > 0;
    }
    get hasSubjective() {
        return !!(this.chiefComplaint || this.subjectiveNarrative) || this.hasPertinentNegatives;
    }
    get hasVitals() {
        return this.vitals.length > 0;
    }
    get hasExamFindings() {
        return this.examFindings.length > 0;
    }
    get hasFunctionalStatus() {
        return this.functionalStatus.length > 0;
    }
    get hasObjective() {
        return this.hasVitals || this.hasExamFindings || this.hasFunctionalStatus;
    }
    get hasAssessment() {
        return this.assessment.length > 0;
    }
    get hasPlanActions() {
        return this.planActions.length > 0;
    }
    get hasInvestigations() {
        return this.investigations.length > 0;
    }
    get hasPatientInstructions() {
        return this.patientInstructions.length > 0;
    }
    get hasPlan() {
        return (
            this.hasPlanActions ||
            this.hasInvestigations ||
            this.hasPatientInstructions ||
            !!this.followUpText
        );
    }
    get hasPrescription() {
        return this.prescription.length > 0;
    }

    get evidenceToggleLabel() {
        return this.showEvidence ? 'Hide evidence' : 'Show evidence';
    }

    // ---------------------------------------------------------------- pdf export

    get pdfLabel() {
        return this.pdfBusy ? 'Building PDF…' : 'Download PDF';
    }

    get hasPdfError() {
        return !!this.pdfError;
    }

    /**
     * Named after the patient and the day, because a clinician downloading
     * three of these in an afternoon has to be able to tell them apart in a
     * downloads folder. Anything a filesystem would object to is replaced.
     */
    get pdfFileName() {
        const who = (this.patientName || this.transcriptName || 'consultation')
            .replace(/[^a-zA-Z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        return `Prescription-${who}-${stamp}.pdf`;
    }

    /**
     * The PDF is built in Apex, not here. Blob.toPdf is the only renderer
     * available without shipping a library as a static resource, and the draft
     * has to be laid out server-side to reach it.
     */
    async handleDownloadPdf() {
        if (this.pdfBusy) {
            return;
        }
        this.pdfError = '';
        this.pdfBusy = true;
        try {
            const base64 = await buildPrescriptionPdf({
                draftJson: this.rawDraft,
                patientContactId: this.patientContactId
            });
            this.saveFile(base64, this.pdfFileName);
        } catch (err) {
            this.pdfError = `The prescription PDF could not be downloaded: ${this.messageFrom(err)}`;
        } finally {
            this.pdfBusy = false;
        }
    }

    /**
     * base64 to a real file. An object URL rather than a data: URL — data URLs
     * of this size are refused as downloads in some browsers, and the object
     * URL is revoked straight after so the blob is not held for the session.
     *
     * The anchor is never added to the document: appending to document.body
     * from inside a component is exactly what Lightning Web Security is there
     * to stop, and a detached anchor still downloads.
     */
    saveFile(base64, filename) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        try {
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            link.click();
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    handleToggleEvidence() {
        this.showEvidence = !this.showEvidence;
    }

    /** Gives each row a stable key and attaches its quote, if it is being shown. */
    withEvidence(list, prefix, mapFn) {
        return this.asArray(list).map((raw, i) => {
            const ev = this.evidenceOf(raw);
            return {
                id: `${prefix}-${i}`,
                ...mapFn(raw, i),
                quote: ev.quote,
                at: ev.at,
                english: ev.english,
                display: ev.display,
                isTranslated: ev.isTranslated,
                showQuote: this.showEvidence && ev.hasEvidence
            };
        });
    }

    evidenceOf(row) {
        const e = row && row.evidence;
        if (!e || !e.quote) {
            return {
                hasEvidence: false,
                quote: '',
                at: '',
                english: '',
                display: '',
                isTranslated: false
            };
        }
        // The draft reads in English, so a translated quote is what goes on
        // screen. It is labelled as translated rather than passed off as
        // verbatim — showing a translation in quotation marks as though those
        // were the words spoken is its own kind of clinical error.
        //
        // The original survives where it legally matters: PrescriptionController
        // writes the spoken words, and the translation beneath them, onto the
        // Prescription record itself.
        const english = e.english || '';
        return {
            hasEvidence: true,
            quote: e.quote,
            at: e.at || '',
            english: english,
            display: english || e.quote,
            isTranslated: !!english
        };
    }

    /** The model can return null, a bare object, or the array we asked for. */
    asArray(value) {
        if (!value) {
            return [];
        }
        return Array.isArray(value) ? value.filter(Boolean) : [value];
    }

    // -------------------------------------------------------------- audio graph

    /**
     * Pinned to 16 kHz because Sarvam takes 8 kHz or 16 kHz and nothing else.
     * Asking the context for a rate makes the browser resample for us, which is
     * far better than decimating by hand: Chrome runs the same resampler it uses
     * for WebRTC, where naive sample-dropping would alias and cost accuracy on
     * exactly the consonants that separate one drug name from another.
     */
    sampleRate() {
        if (!this.audioContext) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            try {
                this.audioContext = new Ctor({ sampleRate: SAMPLE_RATE });
            } catch (err) {
                // Older engines reject the option rather than ignoring it. The
                // graph still works; the WAV header is written from whatever we
                // actually got, so the audio stays correctly pitched.
                this.audioContext = new Ctor();
            }
        }
        return this.audioContext.sampleRate;
    }

    startAudioGraph() {
        // sampleRate() is what builds the context, and it has to be called
        // before anything reads this.audioContext. It used to be reached via the
        // socket setup; nothing else calls it on this path.
        this.captureRate = this.sampleRate();
        const ctx = this.audioContext;
        this.source = ctx.createMediaStreamSource(this.stream);
        // ScriptProcessor is deprecated in favour of AudioWorklet, but a worklet
        // needs its processor loaded from a separate module URL, which means a
        // static resource and an extra LWS hop for no behavioural gain here.
        this.processor = ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);

        this.processor.onaudioprocess = (e) => {
            const samples = e.inputBuffer.getChannelData(0);
            this.measure(samples);
            if (this.closing) {
                return;
            }
            // Kept rather than streamed. getChannelData hands back a view onto a
            // buffer the graph reuses on the next frame, so this has to be a
            // copy — holding the view would leave every chunk showing whatever
            // the most recent frame happened to contain.
            this.pcmChunks.push(this.toLinear16(samples));
            this.pcmSamples += samples.length;
        };

        this.source.connect(this.processor);
        // Chrome will not run a ScriptProcessor that is not connected to the
        // graph's destination, so terminate it there without routing audio back
        // to the speakers.
        this.processor.connect(ctx.destination);
    }

    /**
     * RMS of the buffer already being kept for the recording, so the meter
     * reflects exactly what will be transcribed rather than a second tap.
     *
     * onaudioprocess fires ~11×/s at this buffer size; the UI is updated at a
     * third of that because re-rendering on every frame buys nothing the eye
     * can see.
     */
    measure(samples) {
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
            sum += samples[i] * samples[i];
        }
        const rms = Math.sqrt(sum / samples.length);

        if (rms > this.sessionPeak) {
            this.sessionPeak = rms;
        }

        this.frameCount++;
        if (this.frameCount % 3 === 0) {
            // Speech sits well below full scale, so scale for legibility and clamp.
            this.level = Math.min(100, Math.round(rms * 400));
        }
    }

    /** Float32 [-1,1] to signed 16-bit little-endian, which is what linear16 means. */
    /**
     * Float samples to signed 16-bit PCM.
     *
     * Returns the typed array, not its underlying buffer. It used to return
     * .buffer because that is what WebSocket.send wanted, and an ArrayBuffer
     * has byteLength rather than length and cannot be indexed — so the WAV
     * writer read undefined, wrote nothing, and produced a file of exactly the
     * right size containing pure silence. Sarvam transcribed it perfectly and
     * reported, correctly, that nobody had said anything.
     */
    toLinear16(input) {
        const out = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return out;
    }

    stopAudioGraph() {
        if (this.processor) {
            this.processor.disconnect();
            this.processor.onaudioprocess = null;
            this.processor = null;
        }
        if (this.source) {
            this.source.disconnect();
            this.source = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    }

    // -------------------------------------------------------------------- audio

    /** Keeps the audio itself, which the transcript alone cannot reconstruct. */
    startTapeBackup() {
        this.recordedParts = [];
        try {
            // The bitrate is requested, not required. An engine that rejects the
            // option gets a plain recorder rather than no recording at all.
            try {
                this.recorder = new MediaRecorder(this.stream, {
                    audioBitsPerSecond: AUDIO_BITS_PER_SECOND
                });
            } catch (unsupported) {
                this.recorder = new MediaRecorder(this.stream);
            }
            this.recorder.ondataavailable = (e) => e.data.size && this.recordedParts.push(e.data);
            this.recorder.start();
        } catch (err) {
            // Not fatal: the transcript is the deliverable, the audio is evidence.
            this.audioNotice = `Audio will not be retained: ${err.message}`;
        }
    }

    /**
     * Resolves exactly once, whatever the recorder does.
     *
     * An earlier version resolved only from onstop, so a recorder that threw on
     * stop() or never fired the event left the promise pending forever and
     * everything after it in handleStop simply never ran.
     */
    stopTapeBackup() {
        return new Promise((resolve) => {
            if (!this.recorder || this.recorder.state === 'inactive') {
                resolve();
                return;
            }

            let settled = false;
            const finish = () => {
                if (!settled) {
                    settled = true;
                    resolve();
                }
            };

            this.recorder.onstop = async () => {
                try {
                    const blob = new Blob(this.recordedParts, { type: this.recorder.mimeType });
                    if (blob.size > AUDIO_MAX_BYTES) {
                        // Refused here rather than attempted and failed server
                        // side, so the reason is the size of the recording and
                        // not an exception the clinician cannot act on.
                        this.audioNotice =
                            `Audio copy not retained: the recording is ${this.megabytes(blob.size)} MB, ` +
                            `over the ${this.megabytes(AUDIO_MAX_BYTES)} MB a single upload can carry. ` +
                            `The transcript and the draft are unaffected.`;
                    } else {
                        await storeAudio({
                            sessionId: this.sessionId,
                            mimeType: blob.type,
                            audioBase64: await this.toBase64(blob)
                        });
                    }
                } catch (err) {
                    // Not fatal: the transcript is already filed by this point.
                    this.audioNotice = `Audio copy not retained: ${this.messageFrom(err)}. The transcript and the draft are unaffected.`;
                }
                finish();
            };

            // eslint-disable-next-line @lwc/lwc/no-async-operation
            setTimeout(finish, AUDIO_TIMEOUT_MS);

            try {
                this.recorder.stop();
            } catch (err) {
                this.audioNotice = `Audio copy not retained: ${err.message}. The transcript and the draft are unaffected.`;
                finish();
            }
        });
    }

    async toBase64(blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const STRIDE = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += STRIDE) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STRIDE));
        }
        return btoa(binary);
    }

    // ----------------------------------------------------------------- persist

    // ------------------------------------------------------------------ cleanup

    teardown() {
        clearInterval(this.tickId);
        this.stopAudioGraph();
        this.releaseMic();
    }

    releaseMic() {
        if (this.stream) {
            this.stream.getTracks().forEach((t) => t.stop());
            this.stream = null;
        }
    }

    fail(message) {
        this.state = 'error';
        this.errorMessage = message;
        // Without this the clock kept ticking on a dead session, which is why a
        // failed connection still looked like a recording in progress.
        clearInterval(this.tickId);
        clearInterval(this.saveTimer);
        this.stopAudioGraph();
        this.releaseMic();
    }

    messageFrom(err) {
        return err?.body?.message || err?.message || 'Unexpected error';
    }
}