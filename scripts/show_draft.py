"""Print a generated draft, indented."""

import json
import sys

draft = json.load(open(sys.argv[1]))["draft"]
print("    (intent: {intent}, by: {by})".format(intent=draft["intent"], by=draft["generatedBy"]))
for line in draft["body"].splitlines():
    print("    | " + line)
