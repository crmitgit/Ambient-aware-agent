/**
 * One diarized utterance, already rebased onto session-relative time.
 *
 * Top-level rather than nested inside AmbientTranscriber because Apex interfaces
 * cannot declare inner types.
 */
public class AmbientUtterance {
    public Decimal startSec;
    public Decimal endSec;
    public String speakerLabel;
    public String text;
    public Decimal confidence;
}