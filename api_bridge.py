#!/usr/bin/env python3
"""
SGA 360° • EcoSync Bot — Bridge JSON API para o Frontend Desktop
Fornece métricas, telemetria PostgreSQL, inspetor de schema, inteligência e gestão de backups.
"""

import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    if _stream is not None:
        try:
            _stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

_DEFAULT_ROOT = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
ROOT = Path(os.environ["ECOSYNC_DATA_DIR"]).resolve() if os.environ.get("ECOSYNC_DATA_DIR") else _DEFAULT_ROOT

import sync_prod

SENSITIVE_KEYS = {"senha", "password", "hash", "token", "secret", "jwt_secret"}


def _mask_sensitive_row(row: dict) -> dict:
    masked = {}
    for k, v in row.items():
        if any(s in k.lower() for s in SENSITIVE_KEYS):
            masked[k] = "••••••••"
        else:
            masked[k] = v
    return masked


def _fetch_db_stats(url: str, timeout: int) -> dict:
    stats = {
        "configured": bool(url),
        "url_masked": sync_prod.mask_url(url) if url else "",
        "online": False,
        "latency_ms": None,
        "version": None,
        "db_size_bytes": 0,
        "db_size_mb": 0.0,
        "active_connections": 0,
        "max_connections": 0,
        "cache_hit_ratio": None,
        "tables_count": 0,
        "total_rows": 0,
        "tables": [],
        "error": None,
    }
    if not url:
        return stats

    try:
        t0 = time.perf_counter()
        conn = sync_prod.psycopg2.connect(url, connect_timeout=timeout)
        t1 = time.perf_counter()
        cur = conn.cursor()
        cur.execute("SELECT version();")
        ver = cur.fetchone()[0]

        cur.execute("""
            SELECT pg_database_size(current_database()),
                   (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()),
                   current_setting('max_connections')::int
        """)
        db_size, active_conns, max_conns = cur.fetchone()

        cur.execute("""
            SELECT COALESCE(sum(blks_hit), 0), COALESCE(sum(blks_read), 0)
            FROM pg_stat_database WHERE datname = current_database()
        """)
        hits, reads = cur.fetchone()
        total_blks = float((hits or 0) + (reads or 0))
        cache_ratio = round((float(hits or 0) / total_blks) * 100, 2) if total_blks > 0 else 100.0

        cur.execute("""
            SELECT t.table_name
            FROM information_schema.tables t
            WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
            ORDER BY t.table_name;
        """)
        tables = [r[0] for r in cur.fetchall()]
        table_stats = []
        total_rows = 0

        for tbl in tables:
            try:
                cur.execute(sync_prod.sql.SQL("SELECT count(*) FROM {}").format(sync_prod.sql.Identifier(tbl)))
                cnt = cur.fetchone()[0]
            except Exception:
                cnt = 0
            table_stats.append({"name": tbl, "rows": cnt})
            total_rows += cnt

        cur.close()
        conn.close()

        stats["online"] = True
        stats["latency_ms"] = round((t1 - t0) * 1000, 1)
        stats["version"] = ver.split(",")[0]
        stats["db_size_bytes"] = int(db_size or 0)
        stats["db_size_mb"] = round((db_size or 0) / (1024 * 1024), 2)
        stats["active_connections"] = int(active_conns or 0)
        stats["max_connections"] = int(max_conns or 0)
        stats["cache_hit_ratio"] = cache_ratio
        stats["tables_count"] = len(tables)
        stats["total_rows"] = total_rows
        stats["tables"] = table_stats
    except Exception as exc:
        stats["error"] = str(exc)

    return stats


def get_status() -> dict:
    """Retorna diagnóstico completo, latência, tamanho, cache e estatísticas de ambos os bancos."""
    sync_prod.load_env(ROOT / ".env")
    sync_prod.load_env(ROOT / ".sync.env")

    local_url = os.environ.get("LOCAL_DATABASE_URL") or os.environ.get("DATABASE_URL")
    prod_url = os.environ.get("PROD_DATABASE_URL") or sync_prod.COOLIFY_DATABASE_URL

    return {
        "success": True,
        "timestamp": dt.datetime.now().isoformat(),
        "local": _fetch_db_stats(local_url, timeout=5),
        "prod": _fetch_db_stats(prod_url, timeout=6),
    }


def _fetch_pg_insights(url: str, timeout: int) -> dict:
    """Extrai métricas profundas de armazenamento, índices, tuplas e locks."""
    out = {
        "online": False,
        "db_size_mb": 0.0,
        "active_connections": 0,
        "max_connections": 0,
        "waiting_locks": 0,
        "cache_hit_ratio": 100.0,
        "tables": [],
        "error": None,
    }
    if not url:
        return out

    try:
        conn = sync_prod.psycopg2.connect(url, connect_timeout=timeout)
        cur = conn.cursor()

        cur.execute("""
            SELECT pg_database_size(current_database()),
                   (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()),
                   current_setting('max_connections')::int,
                   (SELECT count(*) FROM pg_locks l
                    JOIN pg_stat_activity a ON l.pid = a.pid
                    WHERE a.datname = current_database() AND NOT l.granted)
        """)
        db_size, active_conns, max_conns, waiting_locks = cur.fetchone()

        cur.execute("""
            SELECT COALESCE(sum(blks_hit), 0), COALESCE(sum(blks_read), 0)
            FROM pg_stat_database WHERE datname = current_database()
        """)
        hits, reads = cur.fetchone()
        total_blks = float((hits or 0) + (reads or 0))
        cache_ratio = round((float(hits or 0) / total_blks) * 100, 2) if total_blks > 0 else 100.0

        cur.execute("""
            SELECT c.relname,
                   pg_total_relation_size(c.oid),
                   pg_relation_size(c.oid),
                   pg_indexes_size(c.oid),
                   COALESCE(s.n_live_tup, 0),
                   COALESCE(s.n_dead_tup, 0),
                   COALESCE(s.seq_scan, 0),
                   COALESCE(s.idx_scan, 0),
                   s.last_autovacuum
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
            WHERE n.nspname = 'public' AND c.relkind = 'r'
            ORDER BY pg_total_relation_size(c.oid) DESC, c.relname ASC
        """)

        tables = []
        for row in cur.fetchall():
            name, total_b, table_b, idx_b, live, dead, seq_s, idx_s, last_vac = row
            tables.append({
                "name": name,
                "total_kb": round((total_b or 0) / 1024, 1),
                "table_kb": round((table_b or 0) / 1024, 1),
                "index_kb": round((idx_b or 0) / 1024, 1),
                "live_tuples": int(live or 0),
                "dead_tuples": int(dead or 0),
                "seq_scan": int(seq_s or 0),
                "idx_scan": int(idx_s or 0),
                "last_autovacuum": last_vac.strftime("%d/%m %H:%M") if last_vac else "Nunca",
            })

        cur.close()
        conn.close()

        out["online"] = True
        out["db_size_mb"] = round((db_size or 0) / (1024 * 1024), 2)
        out["active_connections"] = int(active_conns or 0)
        out["max_connections"] = int(max_conns or 0)
        out["waiting_locks"] = int(waiting_locks or 0)
        out["cache_hit_ratio"] = cache_ratio
        out["tables"] = tables
    except Exception as exc:
        out["error"] = str(exc)

    return out


def get_insights() -> dict:
    """Retorna telemetria avançada dos bancos + recomendações inteligentes do EcoSync Advisor."""
    sync_prod.load_env(ROOT / ".env")
    sync_prod.load_env(ROOT / ".sync.env")

    local_url = os.environ.get("LOCAL_DATABASE_URL") or os.environ.get("DATABASE_URL")
    prod_url = os.environ.get("PROD_DATABASE_URL") or sync_prod.COOLIFY_DATABASE_URL

    local_ins = _fetch_pg_insights(local_url, timeout=5)
    prod_ins = _fetch_pg_insights(prod_url, timeout=6)

    # Analisa backups acumulados
    backups_info = get_backups().get("backups", {})
    n_prod_bkp = len(backups_info.get("prod", []))
    n_local_bkp = len(backups_info.get("local", []))

    recommendations = []

    if not local_ins["online"] or not prod_ins["online"]:
        offline_list = []
        if not local_ins["online"]:
            offline_list.append("Banco Local")
        if not prod_ins["online"]:
            offline_list.append("Coolify Produção")
        recommendations.append({
            "level": "danger",
            "title": f"Rota indisponível: {', '.join(offline_list)}",
            "desc": "Verifique se o serviço PostgreSQL local está ativo e se há rota de rede configurada para o banco de produção.",
            "action": "settings",
            "action_label": "Verificar Conexões",
        })
    else:
        # Compara contagens exatas de linhas (sem depender de estimativa do autovacuum)
        local_stats = _fetch_db_stats(local_url, timeout=5)
        prod_stats = _fetch_db_stats(prod_url, timeout=6)
        local_map = {t["name"]: t["rows"] for t in local_stats["tables"]}
        prod_map = {t["name"]: t["rows"] for t in prod_stats["tables"]}
        all_names = set(local_map.keys()) | set(prod_map.keys())
        local_ahead = sum(1 for n in all_names if local_map.get(n, 0) > prod_map.get(n, 0))
        prod_ahead = sum(1 for n in all_names if prod_map.get(n, 0) > local_map.get(n, 0))

        if local_ahead > 0 and prod_ahead == 0:
            recommendations.append({
                "level": "info",
                "title": "Direção recomendada: PUSH (Local ➜ Produção)",
                "desc": f"O banco Local possui mais registros em {local_ahead} tabela(s). Execute uma simulação Dry-Run antes de enviar.",
                "action": "sync_push",
                "action_label": "Ir para Sincronização",
            })
        elif prod_ahead > 0 and local_ahead == 0:
            recommendations.append({
                "level": "info",
                "title": "Direção recomendada: PULL (Produção ➜ Local)",
                "desc": f"O servidor Coolify possui mais registros em {prod_ahead} tabela(s). Considere baixar os novos dados.",
                "action": "sync_pull",
                "action_label": "Ir para Sincronização",
            })
        elif local_ahead > 0 and prod_ahead > 0:
            recommendations.append({
                "level": "warning",
                "title": "Alterações concorrentes detectadas nos dois lados",
                "desc": "Ambos os bancos possuem tabelas com contagens maiores que o outro. Use o Modo Incremental (--no-delete) para evitar perda de dados!",
                "action": "diff",
                "action_label": "Abrir Comparador Diff",
            })
        else:
            recommendations.append({
                "level": "success",
                "title": "Ambiente em equilíbrio completo",
                "desc": "Local e Coolify apresentam ótima saúde de cache, zero locks bloqueantes e paridade nominal.",
                "action": None,
                "action_label": None,
            })

        # Verifica dead tuples (bloat) e estatísticas desatualizadas (n_live_tup == 0 com linhas reais)
        high_dead_local = [t["name"] for t in local_ins["tables"] if t["dead_tuples"] >= 50]
        high_dead_prod = [t["name"] for t in prod_ins["tables"] if t["dead_tuples"] >= 50]
        prod_real_total = sum(prod_map.values())
        prod_est_total = sum(t["live_tuples"] for t in prod_ins["tables"])
        stale_stats = (prod_real_total > 50 and prod_est_total < prod_real_total * 0.25)

        if high_dead_local or high_dead_prod or stale_stats:
            desc_parts = []
            if high_dead_local or high_dead_prod:
                desc_parts.append(f"Dead tuples acumuladas em: {', '.join(sorted(set(high_dead_local + high_dead_prod)))}.")
            if stale_stats:
                desc_parts.append("Estatísticas do planejador (ANALYZE) desatualizadas no Coolify.")
            recommendations.append({
                "level": "warning",
                "title": "Manutenção PostgreSQL recomendada (ANALYZE)",
                "desc": " ".join(desc_parts),
                "action": "maintenance",
                "action_label": "Executar ANALYZE",
            })

        if local_ins["waiting_locks"] > 0 or prod_ins["waiting_locks"] > 0:
            recommendations.append({
                "level": "warning",
                "title": "Locks em espera detectados",
                "desc": "Há transações concorrentes aguardando lock. Aguarde a estabilização antes de sincronizar.",
                "action": None,
                "action_label": None,
            })

        # Verifica divergência estrutural (Schema Drift) rápida entre tabelas
        missing_in_prod = sorted(set(local_map.keys()) - set(prod_map.keys()))
        missing_in_local = sorted(set(prod_map.keys()) - set(local_map.keys()))
        if missing_in_prod or missing_in_local:
            recommendations.append({
                "level": "warning",
                "title": "Diferença de Schema detectada",
                "desc": f"Tabelas ausentes no Coolify: {len(missing_in_prod)} | Ausentes no Local: {len(missing_in_local)}.",
                "action": "diff",
                "action_label": "Inspecionar Diff",
            })

    if n_prod_bkp > 15 or n_local_bkp > 15:
        recommendations.append({
            "level": "info",
            "title": f"Retenção de Backups ({n_prod_bkp + n_local_bkp} arquivos)",
            "desc": "Você já possui diversos snapshots acumulados. Considere aplicar a política de retenção mantendo os 10 mais recentes.",
            "action": "backups",
            "action_label": "Gerenciar Backups",
        })

    return {
        "success": True,
        "local": local_ins,
        "prod": prod_ins,
        "recommendations": recommendations,
    }


def get_table_schema(table_name: str) -> dict:
    """Inspeciona colunas, PKs, FKs e índices de uma tabela específica com validação estrita."""
    sync_prod.load_env(ROOT / ".env")
    sync_prod.load_env(ROOT / ".sync.env")

    local_url = os.environ.get("LOCAL_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not local_url:
        return {"success": False, "error": "DATABASE_URL não configurada."}

    try:
        conn = sync_prod.psycopg2.connect(local_url, connect_timeout=5)
        cur = conn.cursor()

        valid_tables = set(sync_prod.list_tables(cur))
        if table_name not in valid_tables:
            cur.close()
            conn.close()
            return {"success": False, "error": f"Tabela '{table_name}' não encontrada no schema public."}

        pk_cols = set(sync_prod.get_primary_key(cur, table_name))

        cur.execute("""
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = %s
            ORDER BY ordinal_position
        """, (table_name,))
        columns = [
            {
                "name": r[0],
                "type": r[1],
                "nullable": r[2] == "YES",
                "default": r[3],
                "is_pk": r[0] in pk_cols,
            }
            for r in cur.fetchall()
        ]

        cur.execute("""
            SELECT kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND tc.table_name = %s
        """, (table_name,))
        fks = [{"column": r[0], "ref_table": r[1], "ref_column": r[2]} for r in cur.fetchall()]

        cur.execute("""
            SELECT indexname, indexdef
            FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = %s
            ORDER BY indexname
        """, (table_name,))
        indexes = [{"name": r[0], "definition": r[1]} for r in cur.fetchall()]

        cur.close()
        conn.close()

        return {
            "success": True,
            "table": table_name,
            "columns": columns,
            "foreign_keys": fks,
            "indexes": indexes,
        }
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def get_diff(direction: str = "push", no_delete: bool = False, tables_filter: str = "") -> dict:
    """Calcula as diferenças de dados e estrutura entre os bancos respeitando .env e filtros."""
    sync_prod.load_env(ROOT / ".env")
    sync_prod.load_env(ROOT / ".sync.env")

    local_url = os.environ.get("LOCAL_DATABASE_URL") or os.environ.get("DATABASE_URL")
    prod_url = os.environ.get("PROD_DATABASE_URL") or sync_prod.COOLIFY_DATABASE_URL

    is_pull = (direction.lower() == "pull")
    if is_pull:
        src_url, dst_url = prod_url, local_url
        src_label, dst_label = "PRODUÇÃO", "LOCAL"
        env_exclude = sync_prod.env_list("SYNC_PULL_EXCLUDE_TABLES", "") or sync_prod.env_list("SYNC_EXCLUDE_TABLES", "")
        delete_missing = not no_delete
    else:
        src_url, dst_url = local_url, prod_url
        src_label, dst_label = "LOCAL", "PRODUÇÃO"
        env_exclude = sync_prod.env_list("SYNC_EXCLUDE_TABLES", "")
        delete_missing = sync_prod.env_bool("SYNC_DELETE_MISSING", True) and not no_delete

    exclude = set(env_exclude)
    wanted = {t.strip() for t in tables_filter.split(",") if t.strip()} if tables_filter else None

    try:
        src = sync_prod.connect(src_url, src_label)
        dst = sync_prod.connect(dst_url, dst_label)
        scur, dcur = src.cursor(), dst.cursor()

        tables = [t for t in sync_prod.list_tables(scur) if t not in exclude]
        if wanted:
            tables = [t for t in tables if t in wanted]
        tables = sync_prod.topo_sort(tables, sync_prod.get_fk_dependencies(scur))

        schema_actions = sync_prod.plan_schema(scur, dcur, tables)
        dst_tables = set(sync_prod.list_tables(dcur))

        diffs = [sync_prod.diff_table(scur, dcur, t, t in dst_tables) for t in tables]
        if not delete_missing:
            for d in diffs:
                d["deletes"] = []

        total_inserts = sum(d["inserts"] for d in diffs if not d["skipped"])
        total_updates = sum(d["updates"] for d in diffs if not d["skipped"])
        total_deletes = sum(len(d["deletes"]) for d in diffs if not d["skipped"])

        tables_summary = []
        affects_users = False
        for d in diffs:
            deletes_count = len(d["deletes"])
            has_changes = (d["inserts"] > 0 or d["updates"] > 0 or deletes_count > 0)
            if d["table"] == "usuarios" and has_changes:
                affects_users = True
            tables_summary.append({
                "table": d["table"],
                "inserts": d["inserts"],
                "updates": d["updates"],
                "deletes": deletes_count,
                "skipped": d["skipped"],
                "in_sync": (not has_changes and not d["skipped"]),
            })

        scur.close()
        dcur.close()
        src.close()
        dst.close()

        return {
            "success": True,
            "direction": direction.lower(),
            "delete_missing": delete_missing,
            "affects_users": affects_users,
            "excluded": sorted(exclude),
            "src_label": src_label,
            "dst_label": dst_label,
            "schema_changes_count": len(schema_actions),
            "schema_actions": [desc for desc, _ in schema_actions],
            "total_inserts": total_inserts,
            "total_updates": total_updates,
            "total_deletes": total_deletes,
            "total_changes": total_inserts + total_updates + total_deletes + len(schema_actions),
            "tables": tables_summary,
        }
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def get_backups() -> dict:
    """Lista os backups existentes nas pastas backups_prod e backups_local."""
    result = {"prod": [], "local": []}

    for key, folder_name in (("prod", "backups_prod"), ("local", "backups_local")):
        bdir = ROOT / folder_name
        if not bdir.exists():
            continue
        for p in sorted(bdir.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True):
            stat = p.stat()
            size_kb = round(stat.st_size / 1024, 2)
            mtime = dt.datetime.fromtimestamp(stat.st_mtime).strftime("%d/%m/%Y %H:%M:%S")

            tables_included = []
            total_records = 0
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    tables_included = list(data.keys())
                    total_records = sum(len(rows) for rows in data.values() if isinstance(rows, list))
            except Exception:
                pass

            result[key].append({
                "filename": p.name,
                "folder": key,
                "size_kb": size_kb,
                "date": mtime,
                "tables_count": len(tables_included),
                "total_records": total_records,
                "tables": tables_included[:8],
            })

    return {"success": True, "backups": result}


def preview_backup(folder: str, filename: str) -> dict:
    """Pré-visualiza um arquivo de backup com proteção contra path traversal e mascaramento de senhas."""
    folder_map = {"prod": "backups_prod", "local": "backups_local"}
    if folder not in folder_map:
        return {"success": False, "error": "Pasta de backup inválida."}

    if not filename or Path(filename).name != filename or not filename.endswith(".json"):
        return {"success": False, "error": "Nome de arquivo inválido."}

    base_dir = (ROOT / folder_map[folder]).resolve()
    target = (base_dir / filename).resolve()

    if base_dir not in target.parents or not target.exists() or not target.is_file():
        return {"success": False, "error": "Arquivo de backup não encontrado."}

    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
        summary = []
        for tbl, rows in raw.items():
            if not isinstance(rows, list):
                continue
            sample = [_mask_sensitive_row(r) for r in rows[:3] if isinstance(r, dict)]
            summary.append({
                "table": tbl,
                "count": len(rows),
                "sample": sample,
            })
        return {
            "success": True,
            "filename": filename,
            "folder": folder,
            "tables": summary,
        }
    except Exception as exc:
        return {"success": False, "error": f"Erro ao ler JSON: {exc}"}


def cleanup_backups(keep: int = 10) -> dict:
    """Política de retenção inteligente: remove snapshots antigos mantendo os N mais recentes por pasta."""
    keep = max(3, int(keep))
    removed_files = 0
    freed_bytes = 0

    for folder_name in ("backups_prod", "backups_local"):
        bdir = ROOT / folder_name
        if not bdir.exists():
            continue
        files = sorted(bdir.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True)
        for old_file in files[keep:]:
            try:
                sz = old_file.stat().st_size
                old_file.unlink()
                removed_files += 1
                freed_bytes += sz
            except Exception:
                pass

    return {
        "success": True,
        "keep": keep,
        "removed_files": removed_files,
        "freed_kb": round(freed_bytes / 1024, 2),
    }


def auth_lookup(email: str) -> dict:
    """Consulta usuário na tabela usuarios (Local com fallback para Coolify) para validação de senha no main.js."""
    email = (email or "").strip().lower()
    if not email:
        return {"success": False, "error": "E-mail não informado."}

    sync_prod.load_env(ROOT / ".env")
    sync_prod.load_env(ROOT / ".sync.env")

    local_url = os.environ.get("LOCAL_DATABASE_URL") or os.environ.get("DATABASE_URL")
    prod_url = os.environ.get("PROD_DATABASE_URL") or sync_prod.COOLIFY_DATABASE_URL

    last_error = None
    for src_key, url in (("local", local_url), ("prod", prod_url)):
        if not url:
            continue
        try:
            conn = sync_prod.psycopg2.connect(url, connect_timeout=4)
            cur = conn.cursor()
            cur.execute("""
                SELECT id, nome, email, senha_hash, cargo, perfil, ativo, status_aprovacao
                FROM public.usuarios
                WHERE lower(email) = %s
                LIMIT 1
            """, (email,))
            row = cur.fetchone()
            cur.close()
            conn.close()
            if not row:
                return {"success": True, "db_online": True, "found": False, "source_db": src_key}
            return {
                "success": True,
                "db_online": True,
                "found": True,
                "source_db": src_key,
                "user": {
                    "id": row[0],
                    "nome": row[1],
                    "email": row[2],
                    "senha_hash": row[3],
                    "cargo": row[4] or "",
                    "perfil": (row[5] or "PADRAO").upper(),
                    "ativo": bool(row[6]),
                    "status_aprovacao": (row[7] or "APROVADO").upper(),
                },
            }
        except Exception as exc:
            last_error = str(exc)

    return {
        "success": False,
        "db_online": False,
        "error": last_error or "Nenhum banco PostgreSQL acessível para autenticação.",
    }


def touch_login(user_id: str, source_db: str = "local") -> dict:
    """Atualiza ultimo_acesso do usuário autenticado."""
    if not user_id:
        return {"success": False}
    sync_prod.load_env(ROOT / ".env")
    sync_prod.load_env(ROOT / ".sync.env")
    url = (
        (os.environ.get("PROD_DATABASE_URL") or sync_prod.COOLIFY_DATABASE_URL)
        if source_db == "prod"
        else (os.environ.get("LOCAL_DATABASE_URL") or os.environ.get("DATABASE_URL"))
    )
    if not url:
        return {"success": False}
    try:
        conn = sync_prod.psycopg2.connect(url, connect_timeout=4)
        cur = conn.cursor()
        cur.execute("UPDATE public.usuarios SET ultimo_acesso = CURRENT_TIMESTAMP WHERE id = %s", (user_id,))
        conn.commit()
        cur.close()
        conn.close()
        return {"success": True}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def get_table_diff_detail(direction: str, table_name: str, no_delete: bool = False) -> dict:
    """Retorna amostra detalhada de inserções, alterações (antes/depois) e remoções de uma tabela."""
    sync_prod.load_env(ROOT / ".env")
    sync_prod.load_env(ROOT / ".sync.env")
    local_url = os.environ.get("LOCAL_DATABASE_URL") or os.environ.get("DATABASE_URL")
    prod_url = os.environ.get("PROD_DATABASE_URL") or sync_prod.COOLIFY_DATABASE_URL

    is_pull = direction.lower() == "pull"
    src_url, dst_url = (prod_url, local_url) if is_pull else (local_url, prod_url)
    src_label, dst_label = ("PRODUÇÃO", "LOCAL") if is_pull else ("LOCAL", "PRODUÇÃO")

    try:
        src = sync_prod.connect(src_url, src_label)
        dst = sync_prod.connect(dst_url, dst_label)
        scur, dcur = src.cursor(), dst.cursor()

        src_tables = set(sync_prod.list_tables(scur))
        if table_name not in src_tables:
            scur.close(); dcur.close(); src.close(); dst.close()
            return {"success": False, "error": f"Tabela '{table_name}' não encontrada na origem."}

        dst_tables = set(sync_prod.list_tables(dcur))
        info = sync_prod.diff_table(scur, dcur, table_name, table_name in dst_tables)
        scur.close(); dcur.close(); src.close(); dst.close()

        if info["skipped"]:
            return {"success": True, "table": table_name, "skipped": info["skipped"], "inserts": [], "updates": [], "deletes": []}

        cols = info["columns"]
        pk = info["pk"]
        pk_idx = [cols.index(k) for k in pk]
        snapshot = info.get("dst_snapshot", {})
        delete_missing = (not no_delete) if is_pull else (sync_prod.env_bool("SYNC_DELETE_MISSING", True) and not no_delete)

        inserts_sample = []
        updates_sample = []
        for row in info["upserts"]:
            key = tuple(row[i] for i in pk_idx)
            dst_row = snapshot.get(key)
            src_dict = _mask_sensitive_row(dict(zip(cols, row)))
            if dst_row is None:
                if len(inserts_sample) < 12:
                    inserts_sample.append(src_dict)
            else:
                if len(updates_sample) < 12:
                    dst_dict = _mask_sensitive_row(dict(zip(cols, dst_row)))
                    changed_fields = []
                    for c in cols:
                        if dst_dict.get(c) != src_dict.get(c):
                            changed_fields.append({"field": c, "before": dst_dict.get(c), "after": src_dict.get(c)})
                    updates_sample.append({
                        "pk": dict(zip(pk, key)),
                        "changes": changed_fields,
                    })

        deletes_sample = []
        if delete_missing:
            for k in info["deletes"][:12]:
                dst_row = snapshot.get(k)
                deletes_sample.append(_mask_sensitive_row(dict(zip(cols, dst_row))) if dst_row else dict(zip(pk, k)))

        return {
            "success": True,
            "table": table_name,
            "direction": direction.lower(),
            "pk": pk,
            "total_inserts": info["inserts"],
            "total_updates": info["updates"],
            "total_deletes": len(info["deletes"]) if delete_missing else 0,
            "inserts": inserts_sample,
            "updates": updates_sample,
            "deletes": deletes_sample,
        }
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def run_maintenance(target: str = "both") -> dict:
    """Executa ANALYZE seguro no Local e/ou Coolify para atualizar estatísticas de tuplas e índices."""
    sync_prod.load_env(ROOT / ".env")
    sync_prod.load_env(ROOT / ".sync.env")
    local_url = os.environ.get("LOCAL_DATABASE_URL") or os.environ.get("DATABASE_URL")
    prod_url = os.environ.get("PROD_DATABASE_URL") or sync_prod.COOLIFY_DATABASE_URL

    results = {}
    targets = [("local", local_url), ("prod", prod_url)] if target == "both" else (
        [("local", local_url)] if target == "local" else [("prod", prod_url)]
    )
    for key, url in targets:
        if not url:
            results[key] = {"success": False, "error": "URL não configurada"}
            continue
        try:
            conn = sync_prod.psycopg2.connect(url, connect_timeout=8)
            conn.autocommit = True
            cur = conn.cursor()
            cur.execute("ANALYZE;")
            cur.close()
            conn.close()
            results[key] = {"success": True}
        except Exception as exc:
            results[key] = {"success": False, "error": str(exc)}

    ok_any = any(v.get("success") for v in results.values())
    return {"success": ok_any, "results": results}


def restore_backup(folder: str, filename: str) -> dict:
    """Restaura um snapshot JSON de backup de forma transacional, salvando pré-backup de segurança."""
    folder_map = {"prod": "backups_prod", "local": "backups_local"}
    if folder not in folder_map:
        return {"success": False, "error": "Pasta de backup inválida."}
    if not filename or Path(filename).name != filename or not filename.endswith(".json"):
        return {"success": False, "error": "Nome de arquivo inválido."}

    base_dir = (ROOT / folder_map[folder]).resolve()
    target_file = (base_dir / filename).resolve()
    if base_dir not in target_file.parents or not target_file.exists():
        return {"success": False, "error": "Arquivo de backup não encontrado."}

    sync_prod.load_env(ROOT / ".env")
    sync_prod.load_env(ROOT / ".sync.env")
    dst_url = (
        (os.environ.get("PROD_DATABASE_URL") or sync_prod.COOLIFY_DATABASE_URL)
        if folder == "prod"
        else (os.environ.get("LOCAL_DATABASE_URL") or os.environ.get("DATABASE_URL"))
    )
    if not dst_url:
        return {"success": False, "error": f"URL de destino ({folder}) não configurada."}

    try:
        payload = json.loads(target_file.read_text(encoding="utf-8"))
        if not isinstance(payload, dict) or not payload:
            return {"success": False, "error": "Snapshot vazio ou formato JSON inválido."}

        conn = sync_prod.connect(dst_url, folder.upper())
        cur = conn.cursor()
        valid_tables = set(sync_prod.list_tables(cur))
        target_tables = [t for t in payload.keys() if t in valid_tables and isinstance(payload[t], list)]
        if not target_tables:
            cur.close(); conn.close()
            return {"success": False, "error": "Nenhuma tabela válida encontrada no snapshot."}

        # Ordena respeitando chaves estrangeiras
        ordered_tables = sync_prod.topo_sort(target_tables, sync_prod.get_fk_dependencies(cur))

        # Salva pré-backup de segurança antes da restauração
        safety_payload = {}
        for tbl in ordered_tables:
            cols = [c[0] for c in sync_prod.get_columns(cur, tbl)]
            pk = sync_prod.get_primary_key(cur, tbl)
            if pk:
                snap = sync_prod.fetch_rows(cur, tbl, cols, pk)
                safety_payload[tbl] = [dict(zip(cols, r)) for r in snap.values()]
        stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        safety_path = base_dir / f"pre_restore_{folder}_{stamp}.json"
        safety_path.write_text(
            json.dumps(safety_payload, ensure_ascii=False, indent=2, default=sync_prod.json_default),
            encoding="utf-8",
        )

        restored_rows = 0
        for tbl in ordered_tables:
            rows_dicts = payload.get(tbl) or []
            if not rows_dicts:
                continue
            src_cols_meta = sync_prod.get_columns(cur, tbl)
            valid_cols = [c[0] for c in src_cols_meta]
            json_cols = {c[0] for c in src_cols_meta if c[2] in ("json", "jsonb")}
            pk = sync_prod.get_primary_key(cur, tbl)
            if not pk:
                continue

            cols_to_write = [c for c in valid_cols if any(c in r for r in rows_dicts)]
            if not all(k in cols_to_write for k in pk):
                continue

            upserts = [tuple(r.get(c) for c in cols_to_write) for r in rows_dicts if isinstance(r, dict)]
            sync_prod.apply_upserts(cur, {
                "table": tbl,
                "columns": cols_to_write,
                "pk": pk,
                "json_cols": json_cols,
                "upserts": upserts,
            })
            sync_prod.reset_sequences(cur, tbl, cols_to_write)
            restored_rows += len(upserts)

        conn.commit()
        cur.close()
        conn.close()
        return {
            "success": True,
            "folder": folder,
            "filename": filename,
            "tables_count": len(ordered_tables),
            "restored_rows": restored_rows,
            "safety_backup": safety_path.name,
        }
    except Exception as exc:
        try:
            conn.rollback()
        except Exception:
            pass
        return {"success": False, "error": f"Falha na restauração (rollback aplicado): {exc}"}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Comando não especificado."}))
        sys.exit(1)

    cmd = sys.argv[1].lower()
    if cmd == "status":
        out = get_status()
    elif cmd == "insights":
        out = get_insights()
    elif cmd == "schema":
        table_name = sys.argv[2] if len(sys.argv) > 2 else ""
        out = get_table_schema(table_name)
    elif cmd == "diff":
        direction = sys.argv[2] if len(sys.argv) > 2 else "push"
        no_delete = "--no-delete" in sys.argv[3:]
        tables_filter = ""
        for a in sys.argv[3:]:
            if a.startswith("--tables="):
                tables_filter = a.split("=", 1)[1]
        out = get_diff(direction, no_delete=no_delete, tables_filter=tables_filter)
    elif cmd == "diff-detail":
        direction = sys.argv[2] if len(sys.argv) > 2 else "push"
        table_name = sys.argv[3] if len(sys.argv) > 3 else ""
        no_delete = "--no-delete" in sys.argv[4:]
        out = get_table_diff_detail(direction, table_name, no_delete=no_delete)
    elif cmd == "backups":
        out = get_backups()
    elif cmd == "preview":
        folder = sys.argv[2] if len(sys.argv) > 2 else ""
        filename = sys.argv[3] if len(sys.argv) > 3 else ""
        out = preview_backup(folder, filename)
    elif cmd == "cleanup_backups":
        keep = int(sys.argv[2]) if len(sys.argv) > 2 else 10
        out = cleanup_backups(keep)
    elif cmd == "restore":
        folder = sys.argv[2] if len(sys.argv) > 2 else ""
        filename = sys.argv[3] if len(sys.argv) > 3 else ""
        out = restore_backup(folder, filename)
    elif cmd == "maintenance":
        target = sys.argv[2] if len(sys.argv) > 2 else "both"
        out = run_maintenance(target)
    elif cmd == "auth-lookup":
        raw_stdin = sys.stdin.read().strip() if (sys.stdin and not sys.stdin.isatty()) else ""
        email = ""
        if raw_stdin:
            try:
                email = json.loads(raw_stdin).get("email", "")
            except Exception:
                email = ""
        elif len(sys.argv) > 2:
            email = sys.argv[2]
        out = auth_lookup(email)
    elif cmd == "touch-login":
        uid = sys.argv[2] if len(sys.argv) > 2 else ""
        sdb = sys.argv[3] if len(sys.argv) > 3 else "local"
        out = touch_login(uid, sdb)
    else:
        out = {"error": f"Comando '{cmd}' desconhecido"}

    print(json.dumps(out, ensure_ascii=False, indent=2, default=sync_prod.json_default))


if __name__ == "__main__":
    main()
