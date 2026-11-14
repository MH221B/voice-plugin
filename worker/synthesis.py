class RequestContext:
    """Per-request cancellation and diagnostic channel for a backend."""

    def __init__(self, cancelled=lambda: False, diagnostic=lambda message: None):
        self.cancelled = cancelled
        self.diagnostic = diagnostic

    def check_cancelled(self, message):
        if self.cancelled():
            raise RuntimeError(message)
