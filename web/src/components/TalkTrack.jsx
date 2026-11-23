import { ClaimTag } from "./Bits";

export default function TalkTrack({ talk }) {
  return (
    <div className="panel">
      <h2 className="panel__title">Talk track <ClaimTag /></h2>
      <ol className="talk" data-testid="talk-track">
        {talk.map((t) => <li key={t.id}><h3>{t.title}</h3><p>{t.say}</p></li>)}
      </ol>
      {/* The one primary action: the talk track exists to be walked through, and its first step is on the Evaluate tab. */}
      <button type="button" className="primary" onClick={() => { window.location.hash = "#evaluate"; }}>Start the walkthrough</button>
    </div>
  );
}
