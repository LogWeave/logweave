"""Sentence embedding via fastembed (all-MiniLM-L6-v2, ONNX).

Lazy-loads the model on first call (~2s cold start). CPU-only,
no PyTorch dependency. All methods are synchronous — callers wrap
in asyncio.to_thread() for async contexts.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from fastembed import TextEmbedding

logger = logging.getLogger(__name__)

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
DIMENSIONS = 384


class EmbeddingService:
    MODEL_NAME = MODEL_NAME
    DIMENSIONS = DIMENSIONS

    def __init__(self) -> None:
        self._model: TextEmbedding | None = None

    def _ensure_model(self) -> TextEmbedding:
        if self._model is None:
            from fastembed import TextEmbedding

            logger.info("Loading embedding model %s", self.MODEL_NAME)
            self._model = TextEmbedding(model_name=self.MODEL_NAME)
            logger.info("Embedding model loaded (%d dimensions)", self.DIMENSIONS)
        return self._model

    def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed one or more texts. Returns list of 384-dim float vectors."""
        if not texts:
            return []
        model = self._ensure_model()
        return [e.tolist() for e in model.embed(texts)]

    @property
    def ready(self) -> bool:
        return self._model is not None
