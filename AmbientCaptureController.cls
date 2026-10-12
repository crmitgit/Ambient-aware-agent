/**
 * LWC-facing entry points for ambient capture.
 *
 * The browser owns the microphone and nothing else: it opens a session, posts
 * self-contained audio chunks, and closes the session. Every decision about
 * transcription, storage and clinical linkage happens server-side, which is what
 * keeps the ASR key out of the browser.
 */
public with sharing class AmbientCaptureController {
    /** Opens a session against an encounter and returns the id the LWC records under. */
    @AuraEnabled
    public static Ambient_Session__c startSession(String encounterId) {
        try {
            Ambient_Session__c session = new Ambient_Session__c(
                Status__c = 'Recording',
                Started_At__c = System.now(),
                Chunk_Count__c = 0,
                Audio_Retained__c = true
            );

            // Denormalise the patient onto the session so the capture UI never
            // has to traverse the encounter mid-recording.
            if (String.isNotBlank(encounterId)) {
                List<ClinicalEncounter> encounters = [
                    SELECT Id, PatientId, Doctor__c
                    FROM ClinicalEncounter
                    WHERE Id = :encounterId
                    WITH USER_MODE
                    LIMIT 1
                ];
                if (!encounters.isEmpty()) {
                    session.Clinical_Encounter__c = encounters[0].Id;
                    session.Patient__c = encounters[0].PatientId;
                    session.Clinician__c = encounters[0].Doctor__c;
                }
            }

            insert as user session;
            return session;
        } catch (Exception e) {
            throw new AuraHandledException('Could not start session: ' + e.getMessage());
        }
    }

    /**
     * Stores the session's audio.
     *
     * The transcript arrives over the Deepgram socket, so the recording is kept
     * only as the evidence behind it — nothing is transcribed from here.
     */
    @AuraEnabled
    public static void storeAudio(String sessionId, String mimeType, String audioBase64) {
        try {
            insert as user new ContentVersion(
                Title = 'session-audio',
                PathOnClient = 'session-audio' + extensionFor(mimeType),
                VersionData = EncodingUtil.base64Decode(audioBase64),
                FirstPublishLocationId = sessionId
            );
        } catch (Exception e) {
            throw new AuraHandledException('Audio not stored: ' + e.getMessage());
        }
    }

    /** Closes the session. Status moves to Review once the queued chunks drain. */
    @AuraEnabled
    public static void endSession(String sessionId, Decimal durationSec) {
        try {
            update as user new Ambient_Session__c(
                Id = sessionId,
                Ended_At__c = System.now(),
                Duration_Sec__c = durationSec,
                Status__c = 'Processing'
            );
        } catch (Exception e) {
            throw new AuraHandledException('Could not close session: ' + e.getMessage());
        }
    }

    private static String extensionFor(String mimeType) {
        if (String.isBlank(mimeType)) {
            return '.webm';
        }
        return mimeType.containsIgnoreCase('mp4') ? '.mp4' : '.webm';
    }
}