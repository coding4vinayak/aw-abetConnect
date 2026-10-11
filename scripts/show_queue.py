"""Print a ranked queue response in a readable form."""

import json
import sys

data = json.load(open(sys.argv[1]))
print("  counts:", data.get("counts"))
for thread in data["threads"]:
    contact = thread["contact"]
    who = contact.get("name") or contact.get("email") or contact.get("phone") or "unknown"
    channels = "+".join(thread["channels"])
    print(
        "  {score:>3}  {bucket:<7} {intent:<10} {channels:<16} {who}".format(
            score=thread["score"],
            bucket=thread["bucket"],
            intent=thread["intent"] or "-",
            channels=channels,
            who=who,
        )
    )
