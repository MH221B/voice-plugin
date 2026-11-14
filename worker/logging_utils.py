import os
import sys
import traceback


def log_exception():
    if os.environ.get("VOICE_WORKER_LOG") == "1":
        try:
            traceback.print_exc(file=sys.stderr)
        except Exception:
            pass
