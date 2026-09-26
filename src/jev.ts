// Thin wrapper around Jev's Choice primitive for commute decisioning.

type TransportOption = {
  mode: string;
  etaMinutes: number | null;
  reliability: string;
  raw: unknown;
};

type Decision = {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY!;
const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export async function decide(
  options: TransportOption[],
  nextCommitment?: { what: string; whenISO: string; where: string }
): Promise<Decision | null> {
  const viable = options.filter((o) => o.etaMinutes !== null);
  if (viable.length === 0) return null;

  const stateLines = viable.map(
    (o) => `${o.mode}: ETA ${o.etaMinutes} min, reliability: ${o.reliability}`
  );
  if (nextCommitment) {
    const deadlinePart = nextCommitment.whenISO
      ? `, needs to arrive by ${new Date(nextCommitment.whenISO).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} (factor lateness risk against this deadline when scoring options)`
      : " (no specific deadline stated -- optimize for soonest/most reliable arrival)";
    stateLines.push(
      `User's destination: "${nextCommitment.where}", goal: "${nextCommitment.what}"${deadlinePart}.`
    );
  }

  const criteria: Record<string, string> = {};
  for (const o of viable) {
    criteria[o.mode.replace(/[^a-zA-Z0-9]/g, "_")] = `Take the ${o.mode}`;
  }

  const res = await fetch(JEV_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TYPESAFE_API_KEY}`,
    },
    body: JSON.stringify({
      state: stateLines.join(" "),
      model: "jev-latest",
      questions: {
        best_route: {
          type: "choice",
          instructions:
            "Which option gets the user to their destination most reliably and soonest, given current conditions?",
          criteria,
        },
      },
    }),
  });

  if (!res.ok) return null;
  const data = await res.json();
  const answer = data?.answers?.best_route;
  if (!answer) return null;

  return {
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
  };
}
