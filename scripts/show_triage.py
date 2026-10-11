"""Print a triage result with the signals that produced it."""

import json
import sys

data = json.load(open(sys.argv[1]))
triage = data["triage"]
print(
    "  score {score}  {bucket}  {intent}  (engine: {engine})".format(
        score=triage["score"],
        bucket=triage["bucket"],
        intent=triage["intent"],
        engine=triage["engine"],
    )
)
print("  reason:", triage["reason"])
total = 0
for signal in triage["signals"]:
    total += signal["weight"]
    evidence = signal.get("evidence") or ""
    if len(evidence) > 46:
        evidence = evidence[:46] + "..."
    print(
        "    {weight:>+4}  {kind:<14} {label:<34} {evidence}".format(
            weight=signal["weight"],
            kind=signal["kind"],
            label=signal["label"],
            evidence=evidence,
        )
    )
print("    signals sum to {total}, score is {score}".format(total=total, score=triage["score"]))
