"""Load the exported ../digitnet-weights.js back into a DigitNet (for analysis scripts)."""
import base64
import json
import re

import numpy as np
import torch

from common import HERE, DigitNet


def load_model(path=HERE.parent / "digitnet-weights.js") -> DigitNet:
    text = path.read_text()
    payload = json.loads(re.search(r"const w = (\{.*\});", text).group(1))
    state = {}
    for name, t in payload["tensors"].items():
        a = np.frombuffer(base64.b64decode(t["data"]), dtype="<f4").reshape(t["shape"])
        state[name] = torch.from_numpy(a.copy())
    model = DigitNet()
    model.load_state_dict(state)
    return model.eval()
