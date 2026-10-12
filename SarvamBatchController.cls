/**
 * Diarized transcription of a finished consultation, via Sarvam's batch API.
 *
 * Sarvam is the better model for these consultations — saaras:v3 covers 22
 * Indian languages and is built for Hindi/English code-mixing, which is how
 * these conversations are actually spoken. But it only diarizes in the batch
 * API, never on the live socket, and speaker attribution is what makes the
 * draft readable: without it every turn is unattributed and the prompt cannot
 * tell the clinician from the patient.
 *
 * So the live socket is for the clinician to watch, and this is what the draft
 * is actually generated from. The audio is already being kept on the session,
 * so this costs no extra capture.
 *
 * The key never reaches the browser. Every call here goes through the Sarvam
 * named credential, and the only thing handed out is a presigned upload URL
 * that is write-only, single-object and short-lived.
 *
 * Sarvam's own docs cover step 1 and nothing else, so the rest of this contract
 * was established by probing the live API:
 *
 *   1. POST /speech-to-text/job/v1              -> job_id
 *   2. POST /speech-to-text/job/v1/upload-files -> presigned Azure PUT url
 *   3. PUT  <azure>                             (the browser does this one)
 *   4. POST /speech-to-text/job/v1/{id}/start
 *   5. GET  /speech-to-text/job/v1/{id}/status
 *   6. POST /speech-to-text/job/v1/download-files -> presigned Azure GET url
 *   7. GET  <azure>                             -> diarized_transcript.entries
 *
 * Note the asymmetry, which is easy to get wrong: start and status are scoped
 * under the job id, upload-files and download-files are not.
 */
public with sharing class SarvamBatchController {
    private static final String MODEL = 'saaras:v3';

    /**
     * transcribe, not translate. Sarvam can return English directly, but that
     * would translate the evidence quotes too, and the quote is the audit trail
     * — a clinician checking the note against the recording has to find the
     * words that were actually said. Translation belongs in the draft template,
     * which keeps the original quote and puts English beside it.
     */
    private static final String MODE = 'transcribe';

    /** One name for the one file per job, so nothing has to be threaded back. */
    private static final String AUDIO_FILE = 'consultation.wav';

    private static final Integer TIMEOUT_MS = 60000;

    /** Every presigned URL Sarvam issues sits here; nothing else is callable. */
    private static final String STORAGE_HOST = 'https://appsprodpublicsa.blob.core.windows.net/';

    public class JobStart {
        @AuraEnabled public String jobId;
        /** Write-only, single-object, expires in minutes. Safe to hand out. */
        @AuraEnabled public String uploadUrl;
    }

    public class Utterance {
        @AuraEnabled public Decimal startSec;
        @AuraEnabled public Decimal endSec;
        @AuraEnabled public String speakerLabel;
        @AuraEnabled public String text;
    }

    public class JobResult {
        /** Accepted | Pending | Running | Completed | Failed */
        @AuraEnabled public String state;
        @AuraEnabled public Boolean isDone;
        @AuraEnabled public List<Utterance> utterances;
        @AuraEnabled public String languageCode;
        @AuraEnabled public String error;
    }

    /**
     * Opens a job and returns the URL the browser should PUT the audio to.
     *
     * @param languageCode leave blank to let Sarvam detect the language, which
     *                     is what keeps Hindi in Devanagari and English in Latin.
     *                     Pass a code only to force one language's script.
     * @param speakers     expected voice count; a hint, not a constraint.
     */
    @AuraEnabled
    public static JobStart createJob(String languageCode, Integer speakers) {
        try {
            Map<String, Object> params = new Map<String, Object>{
                'model' => MODEL,
                'mode' => MODE,
                'with_diarization' => true,
                'num_speakers' => speakers == null || speakers < 1 ? 3 : speakers
            };

            // Omitted on purpose: leaving language_code out is what turns on
            // Sarvam's own language detection, and detection is the only setting
            // that renders each language in its own script.
            //
            // Naming a language forces everything into that language's script.
            // With hi-IN, English audio came back as "या एस एस मच एस उम इट्स वर्थ"
            // — the English words, correctly heard, spelled in Devanagari. Not a
            // mis-transcription, which makes it worse: it reads as though the
            // model misheard when it heard perfectly.
            if (String.isNotBlank(languageCode)) {
                params.put('language_code', languageCode);
            }

            HttpResponse created = call(
                'POST',
                '/speech-to-text/job/v1',
                JSON.serialize(new Map<String, Object>{ 'job_parameters' => params })
            );
            // 202, not 200 — the job is accepted rather than done.
            if (created.getStatusCode() != 200 && created.getStatusCode() != 202) {
                throw new CalloutException('Sarvam would not open a job: ' + created.getBody());
            }
            String jobId = text(asMap(JSON.deserializeUntyped(created.getBody())).get('job_id'));
            if (String.isBlank(jobId)) {
                throw new CalloutException('Sarvam opened a job but returned no job id.');
            }

            HttpResponse urls = call(
                'POST',
                '/speech-to-text/job/v1/upload-files',
                JSON.serialize(new Map<String, Object>{
                    'job_id' => jobId,
                    'files' => new List<String>{ AUDIO_FILE }
                })
            );
            if (urls.getStatusCode() != 200) {
                throw new CalloutException('Sarvam would not issue an upload URL: ' + urls.getBody());
            }

            JobStart result = new JobStart();
            result.jobId = jobId;
            result.uploadUrl = fileUrl(urls.getBody(), 'upload_urls');
            if (String.isBlank(result.uploadUrl)) {
                throw new CalloutException('Sarvam returned no upload URL for ' + AUDIO_FILE + '.');
            }
            return result;
        } catch (Exception e) {
            throw new AuraHandledException(reason(e));
        }
    }

    /**
     * Uploads one slice of the recording as an Azure block.
     *
     * The audio cannot go straight from the browser to the storage URL, however
     * much that would suit the size limits: Sarvam's storage account publishes
     * no CORS rules, so the preflight for a cross-origin PUT is refused with
     * CorsPreflightFailure before the body is ever sent. Nothing on the
     * Salesforce side can grant that.
     *
     * So it comes through Apex, in blocks rather than one body. A two-minute
     * consultation is about 3.8 MB of 16 kHz mono PCM, roughly 5.1 MB once
     * base64'd, and holding the encoded string and the decoded blob together
     * would exceed the 6 MB synchronous heap. A slice at a time stays well
     * under it and, unlike a single body, does not have a length beyond which
     * the feature simply stops working.
     */
    @AuraEnabled
    public static void uploadBlock(String uploadUrl, Integer index, String audioBase64) {
        try {
            requireStorageUrl(uploadUrl);
            if (String.isBlank(audioBase64)) {
                throw new CalloutException('No audio in this block.');
            }

            HttpRequest req = new HttpRequest();
            req.setEndpoint(uploadUrl + '&comp=block&blockid=' + EncodingUtil.urlEncode(blockId(index), 'UTF-8'));
            req.setMethod('PUT');
            req.setHeader('Content-Type', 'application/octet-stream');
            req.setBodyAsBlob(EncodingUtil.base64Decode(audioBase64));
            req.setTimeout(TIMEOUT_MS);

            HttpResponse res = new Http().send(req);
            if (res.getStatusCode() != 201) {
                throw new CalloutException(
                    'Block ' + index + ' was rejected (HTTP ' + res.getStatusCode() + ').'
                );
            }
        } catch (Exception e) {
            throw new AuraHandledException(reason(e));
        }
    }

    /**
     * Commits the uploaded blocks into one blob, in order.
     *
     * Until this runs the blocks are staged and the blob does not exist, so a
     * job started early transcribes nothing rather than failing visibly.
     */
    @AuraEnabled
    public static void commitBlocks(String uploadUrl, Integer count) {
        try {
            requireStorageUrl(uploadUrl);
            if (count == null || count < 1) {
                throw new CalloutException('There are no blocks to commit.');
            }

            List<String> parts = new List<String>{ '<?xml version="1.0" encoding="utf-8"?><BlockList>' };
            for (Integer i = 0; i < count; i++) {
                parts.add('<Latest>' + blockId(i) + '</Latest>');
            }
            parts.add('</BlockList>');

            HttpRequest req = new HttpRequest();
            req.setEndpoint(uploadUrl + '&comp=blocklist');
            req.setMethod('PUT');
            req.setHeader('Content-Type', 'application/xml');
            // Sarvam sniffs the container, but the blob is what it reads, so the
            // content type is set here rather than left as octet-stream.
            req.setHeader('x-ms-blob-content-type', 'audio/wav');
            req.setBody(String.join(parts, ''));
            req.setTimeout(TIMEOUT_MS);

            HttpResponse res = new Http().send(req);
            if (res.getStatusCode() != 201) {
                throw new CalloutException(
                    'The audio could not be assembled (HTTP ' + res.getStatusCode() + ').'
                );
            }
        } catch (Exception e) {
            throw new AuraHandledException(reason(e));
        }
    }

    /** Azure wants equal-length, base64 block ids, and orders by the list, not the id. */
    private static String blockId(Integer index) {
        String n = String.valueOf(index);
        while (n.length() < 4) {
            n = '0' + n;
        }
        return EncodingUtil.base64Encode(Blob.valueOf('block' + n));
    }

    /**
     * The upload URL round-trips through the browser, so it is checked before
     * Apex will call it. Without this, anything able to invoke the controller
     * could point a server-side request at a host of its choosing.
     */
    private static void requireStorageUrl(String url) {
        if (String.isBlank(url) || !url.startsWith(STORAGE_HOST)) {
            throw new CalloutException('That is not a Sarvam upload URL.');
        }
    }

    /**
     * Transcribes a few seconds of audio while the consultation is still going.
     *
     * This is the live view, and it is a different problem from the final
     * transcript. Sarvam diarizes only over a whole recording, so speakers
     * cannot be attributed until the end — but the words can be shown as they
     * are spoken, which is what a clinician actually watches for.
     *
     * The synchronous endpoint is used rather than the batch job: it takes the
     * audio in one request and answers in about a second, where a job would need
     * six calls and its own polling for every few seconds of speech.
     *
     * Best-effort by design. A failed chunk returns empty rather than throwing,
     * because a preview that breaks the recording it is previewing is worse than
     * no preview at all. The recording and the final transcript are untouched by
     * anything that happens here.
     */
    @AuraEnabled
    public static String transcribeChunk(String audioBase64) {
        try {
            if (String.isBlank(audioBase64)) {
                return '';
            }

            String boundary = '----AmbientAwareBoundary7MA4YWxkTrZu0gW';
            String footer = '\r\n--' + boundary + '--\r\n';

            // The header is padded through the filename until its base64 carries
            // no '=' — three concatenated base64 strings only decode back to the
            // original bytes if every segment but the last is a whole number of
            // 3-byte groups. Trailing spaces in a filename are ignored.
            String pad = '';
            String header;
            String encodedHeader;
            do {
                header =
                    '--' + boundary + '\r\n' +
                    'Content-Disposition: form-data; name="model"\r\n\r\n' +
                    MODEL + '\r\n' +
                    '--' + boundary + '\r\n' +
                    'Content-Disposition: form-data; name="file"; filename="chunk' + pad + '.wav"\r\n' +
                    'Content-Type: audio/wav\r\n\r\n';
                encodedHeader = EncodingUtil.base64Encode(Blob.valueOf(header));
                pad += ' ';
            } while (encodedHeader.endsWith('=') && pad.length() < 6);

            // The caller pads the audio to a multiple of three bytes for the same
            // reason. If it did not, fall back to the batch path rather than
            // sending a body that will decode into rubbish.
            if (EncodingUtil.base64Encode(EncodingUtil.base64Decode(audioBase64)).endsWith('=')) {
                return '';
            }

            HttpRequest req = new HttpRequest();
            req.setEndpoint('callout:Sarvam/speech-to-text');
            req.setMethod('POST');
            req.setHeader('Content-Type', 'multipart/form-data; boundary=' + boundary);
            req.setBodyAsBlob(
                EncodingUtil.base64Decode(
                    encodedHeader + audioBase64 + EncodingUtil.base64Encode(Blob.valueOf(footer))
                )
            );
            req.setTimeout(TIMEOUT_MS);

            HttpResponse res = new Http().send(req);
            if (res.getStatusCode() != 200) {
                return '';
            }
            return text(asMap(JSON.deserializeUntyped(res.getBody())).get('transcript'));
        } catch (Exception ignored) {
            return '';
        }
    }

    /** Called once every block has been committed. */
    @AuraEnabled
    public static void startJob(String jobId) {
        try {
            requireJobId(jobId);
            HttpResponse res = call('POST', '/speech-to-text/job/v1/' + jobId + '/start', '{}');
            if (res.getStatusCode() != 200 && res.getStatusCode() != 202) {
                throw new CalloutException('Sarvam would not start the job: ' + res.getBody());
            }
        } catch (Exception e) {
            throw new AuraHandledException(reason(e));
        }
    }

    /**
     * One poll. Returns the state, and the diarized utterances once there are
     * any.
     *
     * The LWC drives the polling rather than a queueable chain: a two-minute
     * consultation finishes in seconds, the clinician is watching, and a
     * queueable would have to wait a minimum of a minute between attempts.
     */
    @AuraEnabled
    public static JobResult pollJob(String jobId, String sessionId) {
        try {
            requireJobId(jobId);
            HttpResponse res = call('GET', '/speech-to-text/job/v1/' + jobId + '/status', null);
            if (res.getStatusCode() != 200) {
                throw new CalloutException('Sarvam would not report job status: ' + res.getBody());
            }

            Map<String, Object> body = asMap(JSON.deserializeUntyped(res.getBody()));
            JobResult result = new JobResult();
            result.state = text(body.get('job_state'));
            result.isDone = result.state == 'Completed' || result.state == 'Failed';
            result.utterances = new List<Utterance>();

            if (result.state == 'Failed') {
                String why = text(body.get('error_message'));
                result.error = String.isBlank(why) ? 'Sarvam could not transcribe the audio.' : why;
                return result;
            }
            if (result.state != 'Completed') {
                return result;
            }

            String outputFile = firstOutputName(body);
            if (String.isBlank(outputFile)) {
                result.error = 'Sarvam finished but produced no output file.';
                return result;
            }
            readTranscript(jobId, outputFile, result);
            // Written here rather than from the browser: the utterances are
            // already in hand, and a second round trip only adds a way for the
            // rows and the transcript document to disagree.
            persist(sessionId, result.utterances);
            return result;
        } catch (Exception e) {
            throw new AuraHandledException(reason(e));
        }
    }

    // ---------------------------------------------------------------- results

    private static void readTranscript(String jobId, String outputFile, JobResult result) {
        HttpResponse links = call(
            'POST',
            '/speech-to-text/job/v1/download-files',
            JSON.serialize(new Map<String, Object>{
                'job_id' => jobId,
                'files' => new List<String>{ outputFile }
            })
        );
        if (links.getStatusCode() != 200) {
            throw new CalloutException('Sarvam would not issue a download URL: ' + links.getBody());
        }
        String url = fileUrl(links.getBody(), 'download_urls');
        if (String.isBlank(url)) {
            throw new CalloutException('Sarvam returned no download URL for ' + outputFile + '.');
        }

        // Straight to Azure, not through the named credential: the URL is
        // already signed, and adding the Sarvam key to a storage request would
        // send the credential somewhere it does not belong.
        HttpRequest req = new HttpRequest();
        req.setEndpoint(url);
        req.setMethod('GET');
        req.setTimeout(TIMEOUT_MS);
        HttpResponse res = new Http().send(req);
        if (res.getStatusCode() != 200) {
            throw new CalloutException('Could not read the transcript: ' + res.getStatusCode());
        }

        Map<String, Object> out = asMap(JSON.deserializeUntyped(res.getBody()));
        result.languageCode = text(out.get('language_code'));

        for (Object e : arrayAt(asMap(out.get('diarized_transcript')), 'entries')) {
            Map<String, Object> entry = asMap(e);
            String said = text(entry.get('transcript'));
            if (String.isBlank(said)) {
                continue;
            }
            Utterance u = new Utterance();
            u.text = said;
            u.startSec = decimalOf(entry.get('start_time_seconds'));
            u.endSec = decimalOf(entry.get('end_time_seconds'));
            // Sarvam numbers speakers from "0"; the UI labels them the same way
            // Deepgram's diarization did, so nothing downstream has to change.
            u.speakerLabel = 'Speaker ' + text(entry.get('speaker_id'));
            result.utterances.add(u);
        }

        // Diarization can come back empty on very short or single-voice audio.
        // The flat transcript is still worth having — an unattributed note beats
        // no note — so fall back to it rather than reporting nothing.
        if (result.utterances.isEmpty()) {
            String flat = text(out.get('transcript'));
            if (String.isNotBlank(flat)) {
                Utterance u = new Utterance();
                u.text = flat;
                u.startSec = 0;
                u.endSec = 0;
                u.speakerLabel = 'Speaker 0';
                result.utterances.add(u);
            }
        }
    }

    /**
     * Keeps the turn-by-turn rows alongside the transcript document.
     *
     * Failure here is deliberately swallowed. The transcript is the deliverable
     * and the caller already has it in the return value; losing the audit rows
     * is worth reporting nowhere near as loudly as losing the consultation.
     */
    private static void persist(String sessionId, List<Utterance> utterances) {
        if (String.isBlank(sessionId) || utterances == null || utterances.isEmpty()) {
            return;
        }
        try {
            List<Transcript_Segment__c> rows = new List<Transcript_Segment__c>();
            for (Utterance u : utterances) {
                rows.add(
                    new Transcript_Segment__c(
                        Ambient_Session__c = sessionId,
                        Start_Sec__c = u.startSec,
                        End_Sec__c = u.endSec,
                        Speaker_Label__c = u.speakerLabel,
                        Speaker_Role__c = 'Unknown',
                        Text__c = u.text
                    )
                );
            }
            insert as user rows;
        } catch (Exception ignored) {
            // Intentionally silent; see above.
        }
    }

    // ---------------------------------------------------------------- helpers

    private static HttpResponse call(String method, String path, String body) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:Sarvam' + path);
        req.setMethod(method);
        req.setTimeout(TIMEOUT_MS);
        if (body != null) {
            req.setHeader('Content-Type', 'application/json');
            req.setBody(body);
        }
        return new Http().send(req);
    }

    /** upload_urls / download_urls are keyed by filename, one entry deep. */
    private static String fileUrl(String payload, String key) {
        Map<String, Object> byName = asMap(asMap(JSON.deserializeUntyped(payload)).get(key));
        for (String name : byName.keySet()) {
            String url = text(asMap(byName.get(name)).get('file_url'));
            if (String.isNotBlank(url)) {
                return url;
            }
        }
        return null;
    }

    private static String firstOutputName(Map<String, Object> status) {
        for (Object d : arrayAt(status, 'job_details')) {
            for (Object o : arrayAt(asMap(d), 'outputs')) {
                String name = text(asMap(o).get('file_name'));
                if (String.isNotBlank(name)) {
                    return name;
                }
            }
        }
        return null;
    }

    private static void requireJobId(String jobId) {
        if (String.isBlank(jobId)) {
            throw new CalloutException('No transcription job to work with.');
        }
    }

    /** AuraHandledException swallows getMessage() unless it is set explicitly. */
    private static String reason(Exception e) {
        return e instanceof AuraHandledException ? e.getMessage() : 'Transcription failed: ' + e.getMessage();
    }

    private static Map<String, Object> asMap(Object value) {
        return value instanceof Map<String, Object>
            ? (Map<String, Object>) value
            : new Map<String, Object>();
    }

    private static List<Object> arrayAt(Map<String, Object> source, String key) {
        Object value = source == null ? null : source.get(key);
        return value instanceof List<Object> ? (List<Object>) value : new List<Object>();
    }

    private static String text(Object value) {
        return value == null ? '' : String.valueOf(value).trim();
    }

    private static Decimal decimalOf(Object value) {
        if (value == null) {
            return 0;
        }
        try {
            return Decimal.valueOf(String.valueOf(value));
        } catch (Exception ignored) {
            return 0;
        }
    }
}