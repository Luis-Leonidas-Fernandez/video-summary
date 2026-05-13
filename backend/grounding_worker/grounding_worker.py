#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path
from typing import Any


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Grounding worker for video-study-tool")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--job-id", required=True)
    validate_parser.add_argument("--manifest", required=True)
    validate_parser.add_argument("--claims", nargs="+", required=True)
    validate_parser.add_argument("--output", required=True)
    validate_parser.add_argument("--ollama-base-url", required=True)
    validate_parser.add_argument("--ollama-llm-model", required=True)
    validate_parser.add_argument("--ollama-embed-model", required=True)
    validate_parser.add_argument("--ollama-num-ctx", type=int, default=4096)
    validate_parser.add_argument("--ollama-num-predict", type=int, default=700)
    validate_parser.add_argument("--top-k", type=int, default=3)
    validate_parser.add_argument("--supported-threshold", type=float, default=0.8)
    validate_parser.add_argument("--weak-threshold", type=float, default=0.6)

    return parser


def round_metric(value: float) -> float:
    return round(float(value), 3)


def load_json(path_str: str) -> Any:
    return json.loads(Path(path_str).read_text())


def make_index(
    manifest: dict[str, Any],
    base_url: str,
    llm_model: str,
    embed_model: str,
    llm_num_ctx: int,
    llm_num_predict: int,
    top_k: int,
):
    try:
        from llama_index.core import Document, Settings, VectorStoreIndex
        from llama_index.core.query_engine import CitationQueryEngine
        from llama_index.embeddings.ollama import OllamaEmbedding
        from llama_index.llms.ollama import Ollama
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            "Faltan dependencias Python para grounding. Instalá backend/grounding_worker/requirements.txt"
        ) from exc

    Settings.llm = Ollama(
        model=llm_model,
        base_url=base_url,
        request_timeout=3600.0,
        context_window=llm_num_ctx,
        additional_kwargs={"num_predict": llm_num_predict},
    )
    Settings.embed_model = OllamaEmbedding(model_name=embed_model, base_url=base_url)

    documents = []
    chunk_lookup: dict[str, dict[str, Any]] = {}
    for part in manifest["parts"]:
        for chunk in part["chunks"]:
            chunk_lookup[chunk["chunkId"]] = chunk
            documents.append(
                Document(
                    text=chunk["text"],
                    metadata={
                        "chunkId": chunk["chunkId"],
                        "part": chunk["part"],
                        "order": chunk["order"],
                        "startSeconds": chunk["startSeconds"],
                        "endSeconds": chunk["endSeconds"],
                    },
                    doc_id=chunk["chunkId"],
                )
            )

    index = VectorStoreIndex.from_documents(documents)
    engine = CitationQueryEngine.from_args(
        index,
        similarity_top_k=top_k,
        citation_chunk_size=512,
    )

    return engine, chunk_lookup


def classify_claim(
    engine: Any,
    claim: dict[str, Any],
    evidence_lookup: dict[str, dict[str, Any]],
    chunk_lookup: dict[str, dict[str, Any]],
    supported_threshold: float,
    weak_threshold: float,
) -> tuple[str, dict[str, Any]]:
    citations = claim.get("citations", [])
    cited_chunk_ids = [evidence_lookup[citation]["sourceChunkId"] for citation in citations if citation in evidence_lookup]
    prompt = "\n".join(
        [
            "Decidí si el siguiente claim está respaldado SOLO por el contexto recuperado.",
            "Respondé con una sola línea inicial en uno de estos formatos exactos:",
            "SUPPORTED: <motivo breve>",
            "PARTIALLY_SUPPORTED: <motivo breve>",
            "UNSUPPORTED: <motivo breve>",
            f"Claim: {claim['text']}",
            f"Citas declaradas por el extractor: {', '.join(citations) if citations else 'ninguna'}",
            f"Chunks reales asociados a esas citas: {', '.join(cited_chunk_ids) if cited_chunk_ids else 'ninguno'}",
        ]
    )

    response = engine.query(prompt)
    raw_answer = str(response).strip()
    answer_upper = raw_answer.upper()

    evidence = []
    max_score = 0.0
    for node in getattr(response, "source_nodes", [])[:6]:
        metadata = getattr(getattr(node, "node", None), "metadata", {}) or {}
        chunk_id = metadata.get("chunkId")
        if not chunk_id:
            continue

        score = float(getattr(node, "score", 0.0) or 0.0)
        max_score = max(max_score, score)
        text = getattr(getattr(node, "node", None), "text", "") or chunk_lookup.get(chunk_id, {}).get("text", "")
        citation_id = next((alias for alias, info in evidence_lookup.items() if info.get("sourceChunkId") == chunk_id), "")
        evidence.append(
            {
                "citationId": citation_id,
                "chunkId": chunk_id,
                "score": round_metric(score),
                "quote": text[:400].strip(),
            }
        )

    if answer_upper.startswith("SUPPORTED:"):
        status = "supported"
        reason = raw_answer.split(":", 1)[1].strip() if ":" in raw_answer else "El worker encontró respaldo suficiente."
    elif answer_upper.startswith("PARTIALLY_SUPPORTED:"):
        status = "partially_supported"
        reason = raw_answer.split(":", 1)[1].strip() if ":" in raw_answer else "El worker encontró respaldo parcial."
    elif answer_upper.startswith("UNSUPPORTED:"):
        status = "unsupported"
        reason = raw_answer.split(":", 1)[1].strip() if ":" in raw_answer else "El worker no encontró respaldo suficiente."
    else:
        if max_score >= supported_threshold:
            status = "supported"
        elif max_score >= weak_threshold:
            status = "partially_supported"
        else:
            status = "unsupported"
        reason = raw_answer or "Clasificación derivada del score de recuperación."

    return status, {
        "id": claim["id"],
        "section": claim.get("section", "General"),
        "text": claim["text"],
        "citations": citations,
        "evidence": evidence,
        "reason": reason,
    }


def handle_validate(args: argparse.Namespace) -> int:
    manifest = load_json(args.manifest)
    claims_documents = [load_json(path_str) for path_str in args.claims]
    engine, chunk_lookup = make_index(
        manifest,
        base_url=args.ollama_base_url,
        llm_model=args.ollama_llm_model,
        embed_model=args.ollama_embed_model,
        llm_num_ctx=args.ollama_num_ctx,
        llm_num_predict=args.ollama_num_predict,
        top_k=args.top_k,
    )

    part_reports = []
    for claims_document in claims_documents:
        evidence_lookup = {item["citationId"]: item for item in claims_document.get("evidence", [])}
        supported = []
        partially_supported = []
        unsupported = []

        for claim in claims_document.get("claims", []):
            status, payload = classify_claim(
                engine,
                claim,
                evidence_lookup,
                chunk_lookup,
                supported_threshold=args.supported_threshold,
                weak_threshold=args.weak_threshold,
            )
            if status == "supported":
                supported.append(payload)
            elif status == "partially_supported":
                partially_supported.append(payload)
            else:
                unsupported.append(payload)

        part_reports.append(
            {
                "part": claims_document["part"],
                "claimSupport": {
                    "supported": supported,
                    "unsupported": unsupported,
                    "partiallySupported": partially_supported,
                },
            }
        )

    output = {"parts": part_reports}
    Path(args.output).write_text(json.dumps(output, indent=2, ensure_ascii=False))
    print(f"Validated {sum(len(doc.get('claims', [])) for doc in claims_documents)} claims for {args.job_id}")
    return 0


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        if args.command == "validate":
            return handle_validate(args)
        parser.error("Unknown command")
        return 2
    except Exception as exc:  # noqa: BLE001
        print(f"Grounding worker failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
