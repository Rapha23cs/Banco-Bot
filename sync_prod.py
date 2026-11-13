#!/usr/bin/env python3
"""
==========================================================================
 SGA 360° - Robô / Sincronizador entre Banco LOCAL  ⇄  Banco de PRODUÇÃO
==========================================================================

Funciona nos DOIS sentidos:

  PUSH (padrão)  LOCAL ➜ PRODUÇÃO   O banco local é a fonte da verdade.
  PULL (--pull)  PRODUÇÃO ➜ LOCAL   A produção é a fonte da verdade.

A cada execução, o script compara tabela por tabela e deixa o DESTINO
idêntico ao estado mais recente da ORIGEM:

  1. Estrutura: cria tabelas e colunas que existem na origem e faltam no destino.
  2. Dados:     insere registros novos, atualiza os alterados e (no modo
                espelho) remove do destino o que não existe mais na origem.
  3. Sequências: reajusta os contadores SERIAL para evitar conflito de IDs.

Segurança e Automação:
  - Gera backup em JSON das tabelas do DESTINO afetadas
    (backups_prod/ no push, backups_local/ no pull).
  - Execução transacional: se qualquer etapa falhar, nada é alterado (rollback).
  - Modo Robô / Autônomo: compatível com agendadores de tarefas (Windows Task Scheduler / cron)
    e executáveis PyInstaller (.exe), sem travar esperando digitação no console.

Configuração (.env):
  DATABASE_URL / LOCAL_DATABASE_URL -> banco local (ex: postgresql://postgres:senha@localhost:5432/meu_banco)
  PROD_DATABASE_URL                 -> banco de produção remoto (ex: postgresql://usuario:senha@192.168.0.10:5432/meu_banco)
  SYNC_DIRECTION                    -> direção padrão se omitida ('push' ou 'pull')
  SYNC_AUTO_CONFIRM                 -> true = confirmação automática sem esperar resposta do usuário
  SYNC_EXCLUDE_TABLES               -> tabelas ignoradas (padrão: nenhuma = sincroniza tudo)
  SYNC_DELETE_MISSING               -> true = espelho completo | false = incremental (PUSH)

Uso CLI:
  python sync_prod.py --check          # Testa conexão de rede e credenciais de ambos os bancos
  python sync_prod.py --dry-run        # Mostra as diferenças sem alterar nada
  python sync_prod.py --push --yes     # Robô: PUSH automático sem travas
  python sync_prod.py --pull --yes     # Robô: PULL automático sem travas
  python sync_prod.py                  # Interativo (pergunta direção e pede confirmação 'sim')
"""

import argparse
import datetime as dt
import decimal
import json
import os
import sys
import uuid
from pathlib import Path

try:
    import psycopg2
    import psycopg2.extras
    from psycopg2 import sql
except ImportError:
    print("❌ Dependência ausente. Instale com:  pip install psycopg2-binary")
    sys.exit(1)

# Garante acentos/emojis no console do Windows (cp1252) mesmo sem console anexado
for _stream in (sys.stdout, sys.stderr):
    if _stream is not None:
        try:
            _stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

# Resolução do diretório raiz: se congelado via PyInstaller (.exe), usa sys.executable
_DEFAULT_ROOT = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
ROOT = Path(os.environ["ECOSYNC_DATA_DIR"]).resolve() if os.environ.get("ECOSYNC_DATA_DIR") else _DEFAULT_ROOT

# ==============================================================================
# 🔑 URL DE PRODUÇÃO (COOLIFY) - DEFINIR VIA .env (PROD_DATABASE_URL) OU CLI
# Nunca armazene senhas reais diretamente no código-fonte.
# ==============================================================================
COOLIFY_DATABASE_URL = ""


# --------------------------------------------------------------------------
# Utilidades
# --------------------------------------------------------------------------
def load_env(path: Path) -> None:
    """Carrega o .env sem dependências externas (não sobrescreve variáveis já definidas)."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


def env_bool(name: str, default: bool) -> bool:
    val = os.environ.get(name)
    if val is None or val.strip() == "":
        return default
    return val.strip().lower() in ("1", "true", "sim", "yes", "s", "y")


def env_list(name: str, default: str = "") -> list:
    raw = os.environ.get(name, default)
    return [t.strip() for t in raw.split(",") if t.strip()]


def mask_url(url: str) -> str:
    """Oculta a senha da connection string para exibição segura."""
    try:
        prefix, rest = url.split("://", 1)
        if "@" in rest:
            creds, host = rest.rsplit("@", 1)
            user = creds.split(":", 1)[0]
            return f"{prefix}://{user}:****@{host}"
    except ValueError:
        pass
    return url


def json_default(value):
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (bytes, memoryview)):
        return bytes(value).hex()
    return str(value)


def connect(url: str, label: str):
    """Estabelece conexão com o banco de dados com timeout e tratamento de erro."""
    try:
        conn = psycopg2.connect(url, connect_timeout=10)
        conn.autocommit = False
        return conn
    except Exception as exc:  # noqa: BLE001
        print(f"❌ Não foi possível conectar ao banco {label} ({mask_url(url)}):\n   {exc}")
        sys.exit(1)


def test_connection_diagnostic(url: str, label: str) -> bool:
    """Diagnóstico de rede e versão para o comando --check."""
    print(f"🔍 Testando conexão com banco {label} ({mask_url(url)})...", end=" ", flush=True)
    try:
        start = dt.datetime.now()
        conn = psycopg2.connect(url, connect_timeout=10)
        cur = conn.cursor()
        cur.execute("SELECT version();")
        version_str = cur.fetchone()[0]
        cur.close()
        conn.close()
        elapsed = (dt.datetime.now() - start).total_seconds()
        print(f"✅ OK ({elapsed:.2f}s)")
        print(f"   ℹ️  PostgreSQL: {version_str.split(',')[0]}")
        return True
    except Exception as exc:
        print("❌ FALHA")
        print(f"   ⚠️  Erro: {exc}")
        return False


# --------------------------------------------------------------------------
# Introspecção de schema
# --------------------------------------------------------------------------
def list_tables(cur) -> list:
    cur.execute("""
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
    """)
    return [r[0] for r in cur.fetchall()]


def get_columns(cur, table: str) -> list:
    """Retorna [(nome, tipo_completo, udt_name)] na ordem física."""
    cur.execute("""
        SELECT a.attname,
               format_type(a.atttypid, a.atttypmod),
               t.typname
        FROM pg_attribute a
        JOIN pg_type t ON t.oid = a.atttypid
        WHERE a.attrelid = %s::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
    """, (f'public."{table}"',))
    return cur.fetchall()


def get_primary_key(cur, table: str) -> list:
    cur.execute("""
        SELECT a.attname
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = %s::regclass AND i.indisprimary
        ORDER BY array_position(i.indkey, a.attnum)
    """, (f'public."{table}"',))
    return [r[0] for r in cur.fetchall()]


def get_fk_dependencies(cur) -> dict:
    """{tabela: {tabelas_que_ela_referencia}}"""
    cur.execute("""
        SELECT tc.table_name, ccu.table_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    """)
    deps = {}
    for child, parent in cur.fetchall():
        if child != parent:
            deps.setdefault(child, set()).add(parent)
    return deps


def topo_sort(tables: list, deps: dict) -> list:
    """Ordena pais antes dos filhos (respeitando chaves estrangeiras)."""
    ordered, visited, visiting = [], set(), set()

    def visit(t):
        if t in visited:
            return
        if t in visiting:  # ciclo: segue sem travar
            return
        visiting.add(t)
        for parent in sorted(deps.get(t, ())):
            if parent in tables:
                visit(parent)
        visiting.discard(t)
        visited.add(t)
        ordered.append(t)

    for t in tables:
        visit(t)
    return ordered


# --------------------------------------------------------------------------
# Sincronização de estrutura
# --------------------------------------------------------------------------
def plan_schema(src_cur, dst_cur, tables: list) -> list:
    """Retorna lista de (descricao, sql_composto) para alinhar a estrutura do destino."""
    dst_tables = set(list_tables(dst_cur))
    actions = []

    for table in tables:
        src_cols = get_columns(src_cur, table)

        if table not in dst_tables:
            pk = get_primary_key(src_cur, table)
            col_defs = [
                sql.SQL("{} {}").format(sql.Identifier(name), sql.SQL(ctype))
                for name, ctype, _ in src_cols
            ]
            if pk:
                col_defs.append(sql.SQL("PRIMARY KEY ({})").format(
                    sql.SQL(", ").join(map(sql.Identifier, pk))))
            stmt = sql.SQL("CREATE TABLE {} ({})").format(
                sql.Identifier(table), sql.SQL(", ").join(col_defs))
            actions.append((f"Criar tabela '{table}'", stmt))
            continue

        dst_col_names = {c[0] for c in get_columns(dst_cur, table)}
        for name, ctype, _ in src_cols:
            if name not in dst_col_names:
                stmt = sql.SQL("ALTER TABLE {} ADD COLUMN IF NOT EXISTS {} {}").format(
                    sql.Identifier(table), sql.Identifier(name), sql.SQL(ctype))
                actions.append((f"Adicionar coluna '{table}.{name}' ({ctype})", stmt))

    return actions


# --------------------------------------------------------------------------
# Sincronização de dados
# --------------------------------------------------------------------------
def fetch_rows(cur, table: str, columns: list, pk: list) -> dict:
    query = sql.SQL("SELECT {} FROM {}").format(
        sql.SQL(", ").join(map(sql.Identifier, columns)), sql.Identifier(table))
    cur.execute(query)
    pk_idx = [columns.index(k) for k in pk]
    return {tuple(row[i] for i in pk_idx): row for row in cur.fetchall()}


def diff_table(src_cur, dst_cur, table: str, dst_exists: bool) -> dict:
    src_cols = get_columns(src_cur, table)
    columns = [c[0] for c in src_cols]
    json_cols = {c[0] for c in src_cols if c[2] in ("json", "jsonb")}
    pk = get_primary_key(src_cur, table)

    result = {"table": table, "columns": columns, "json_cols": json_cols, "pk": pk,
              "upserts": [], "inserts": 0, "updates": 0, "deletes": [], "skipped": None}

    if not pk:
        result["skipped"] = "tabela sem chave primária"
        return result

    src_rows = fetch_rows(src_cur, table, columns, pk)

    dst_rows = {}
    if dst_exists:
        dst_col_names = {c[0] for c in get_columns(dst_cur, table)}
        common = [c for c in columns if c in dst_col_names]
        if all(k in common for k in pk):
            raw = fetch_rows(dst_cur, table, common, pk)
            # Reconstrói na ordem das colunas da origem (colunas novas = None)
            for key, row in raw.items():
                as_dict = dict(zip(common, row))
                dst_rows[key] = tuple(as_dict.get(c) for c in columns)

    for key, row in src_rows.items():
        dst_row = dst_rows.get(key)
        if dst_row is None:
            result["upserts"].append(row)
            result["inserts"] += 1
        elif tuple(dst_row) != tuple(row):
            result["upserts"].append(row)
            result["updates"] += 1

    result["deletes"] = [k for k in dst_rows if k not in src_rows]
    result["dst_snapshot"] = dst_rows
    return result


def apply_upserts(cur, info: dict) -> None:
    if not info["upserts"]:
        return
    table, columns, pk, json_cols = info["table"], info["columns"], info["pk"], info["json_cols"]
    non_pk = [c for c in columns if c not in pk]

    rows = []
    for row in info["upserts"]:
        rows.append(tuple(
            psycopg2.extras.Json(v) if (col in json_cols and v is not None) else v
            for col, v in zip(columns, row)
        ))

    if non_pk:
        conflict = sql.SQL("DO UPDATE SET {}").format(sql.SQL(", ").join(
            sql.SQL("{0} = EXCLUDED.{0}").format(sql.Identifier(c)) for c in non_pk))
    else:
        conflict = sql.SQL("DO NOTHING")

    query = sql.SQL("INSERT INTO {} ({}) VALUES %s ON CONFLICT ({}) {}").format(
        sql.Identifier(table),
        sql.SQL(", ").join(map(sql.Identifier, columns)),
        sql.SQL(", ").join(map(sql.Identifier, pk)),
        conflict,
    )
    psycopg2.extras.execute_values(cur, query.as_string(cur), rows, page_size=500)


def apply_deletes(cur, info: dict) -> None:
    if not info["deletes"]:
        return
    table, pk = info["table"], info["pk"]
    if len(pk) == 1:
        query = sql.SQL("DELETE FROM {} WHERE {} = ANY(%s)").format(
            sql.Identifier(table), sql.Identifier(pk[0]))
        cur.execute(query, ([k[0] for k in info["deletes"]],))
    else:
        cond = sql.SQL(" AND ").join(
            sql.SQL("{} = %s").format(sql.Identifier(k)) for k in pk)
        query = sql.SQL("DELETE FROM {} WHERE {}").format(sql.Identifier(table), cond)
        psycopg2.extras.execute_batch(cur, query.as_string(cur), info["deletes"])


def reset_sequences(cur, table: str, columns: list) -> None:
    for col in columns:
        cur.execute("SELECT pg_get_serial_sequence(%s, %s)", (f'public."{table}"', col))
        seq = cur.fetchone()[0]
        if not seq:
            continue
        cur.execute(sql.SQL(
            "SELECT setval(%s, GREATEST(COALESCE(MAX({c}), 0), 1), COALESCE(MAX({c}), 0) > 0) FROM {t}"
        ).format(c=sql.Identifier(col), t=sql.Identifier(table)), (seq,))


def write_backup(diffs: list, backup_dir: Path, prefix: str) -> Path:
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    path = backup_dir / f"{prefix}_backup_{stamp}.json"
    payload = {}
    for info in diffs:
        if not (info["upserts"] or info["deletes"]):
            continue
        snapshot = info.get("dst_snapshot", {})
        payload[info["table"]] = [dict(zip(info["columns"], row)) for row in snapshot.values()]
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=json_default),
                    encoding="utf-8")
    return path


# --------------------------------------------------------------------------
# Execução principal
# --------------------------------------------------------------------------
def main() -> None:
    # 1. Carrega variáveis de ambiente imediatamente a partir do diretório raiz
    load_env(ROOT / ".env")
    load_env(ROOT / ".sync.env")

    parser = argparse.ArgumentParser(
        description="Sincroniza o banco LOCAL com a PRODUÇÃO (Coolify) em qualquer sentido.")
    parser.add_argument("--push", action="store_true",
                        help="Sentido direto: LOCAL ➜ PRODUÇÃO (pula a pergunta interativa).")
    parser.add_argument("--pull", action="store_true",
                        help="Sentido inverso: PRODUÇÃO ➜ LOCAL (pula a pergunta interativa).")
    parser.add_argument("--local", "--local-url", dest="local_url",
                        help="URL de conexão do banco LOCAL (substitui DATABASE_URL do .env).")
    parser.add_argument("--prod", "--prod-url", dest="prod_url",
                        help="URL de conexão do banco de PRODUÇÃO (Coolify).")
    parser.add_argument("--check", action="store_true",
                        help="Apenas testa conectividade de rede e autenticação nos dois bancos e encerra.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Apenas compara e mostra as diferenças, sem aplicar nada.")
    parser.add_argument("--yes", "-y", action="store_true",
                        help="Aplica sem pedir confirmação manual (obrigatório para robôs/automações).")
    parser.add_argument("--non-interactive", action="store_true",
                        help="Força modo não-interativo: não faz perguntas de input e assume PUSH se direção omitida.")
    parser.add_argument("--tables",
                        help="Lista de tabelas específicas separadas por vírgula.")
    parser.add_argument("--exclude",
                        help="Lista de tabelas a ignorar separadas por vírgula.")
    parser.add_argument("--no-delete", action="store_true",
                        help="Não remove do destino registros que não existem na origem.")
    args = parser.parse_args()

    # Identifica se a sessão é interativa (console anexado e sem flag forçada)
    is_interactive = (sys.stdin is not None and sys.stdin.isatty() and not args.non_interactive)

    # 2. Resolução das URLs dos Bancos
    local_url = (
        args.local_url
        or os.environ.get("LOCAL_DATABASE_URL")
        or os.environ.get("DATABASE_URL")
    )

    prod_url = (
        args.prod_url
        or os.environ.get("PROD_DATABASE_URL")
        or (COOLIFY_DATABASE_URL.strip() if COOLIFY_DATABASE_URL else None)
    )

    # Se a flag --check for solicitada, testa ambas as conexões e sai
    if args.check:
        print("=" * 66)
        print(" SGA 360° • Teste de Conectividade dos Bancos de Dados")
        print("=" * 66)
        ok_local = False
        ok_prod = False
        if local_url:
            ok_local = test_connection_diagnostic(local_url, "LOCAL")
        else:
            print("❌ LOCAL_DATABASE_URL / DATABASE_URL não configurada no .env.")

        if prod_url:
            ok_prod = test_connection_diagnostic(prod_url, "PRODUÇÃO")
        else:
            print("❌ PROD_DATABASE_URL não configurada no .env.")

        print("-" * 66)
        if ok_local and ok_prod:
            print("🎉 Tudo pronto! Rotas de rede e conexões ativas com sucesso.")
            sys.exit(0)
        else:
            print("⚠️ Uma ou mais conexões falharam. Verifique credenciais e rede.")
            sys.exit(1)

    if not local_url:
        print("❌ DATABASE_URL ou LOCAL_DATABASE_URL (banco local) não encontrado no .env.")
        sys.exit(1)

    # Se a URL de produção não foi informada, solicita interativamente (se houver terminal)
    if not prod_url:
        if not is_interactive:
            print("❌ PROD_DATABASE_URL (banco de produção) não informada no .env nem via linha de comando.")
            sys.exit(1)

        print("\n🔑 Nenhuma URL de produção foi informada.")
        print("   💡 Dica: você pode configurar PROD_DATABASE_URL no .env ou no script sync_prod.py")
        print("   Exemplo: postgresql://postgres:sua_senha@192.168.0.10:5432/meu_banco")
        try:
            prod_url = input("👉 Cole a URL de conexão do PostgreSQL do Coolify: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nOperação cancelada.")
            sys.exit(1)

    if not prod_url:
        print("❌ URL de produção não fornecida. Abortando.")
        sys.exit(1)

    # Validação contra placeholders comuns
    if any(placeholder in prod_url for placeholder in ("HOST_COOLIFY", ":PORTA", "USUARIO:SENHA", "senha_producao")):
        print("❌ A URL informada ainda contém placeholders de exemplo.")
        print("   Substitua pelos dados reais da sua conexão de produção no .env.")
        sys.exit(1)

    if local_url.strip() == prod_url.strip():
        print("❌ O banco local e o de produção apontam para a mesma URL. Abortando.")
        sys.exit(1)

    # 3. Resolução da Direção (PUSH vs PULL)
    env_dir = os.environ.get("SYNC_DIRECTION", "").strip().lower()
    if args.pull:
        is_pull = True
    elif args.push:
        is_pull = False
    elif env_dir in ("pull", "2"):
        is_pull = True
    elif env_dir in ("push", "1"):
        is_pull = False
    elif is_interactive:
        print("=" * 66)
        print(" SGA 360° • Sincronizador de Banco de Dados")
        print("=" * 66)
        print(" O que você deseja fazer?")
        print("   [1] PUSH  (LOCAL ➜ PRODUÇÃO)   [Envia seus dados locais para o Coolify]")
        print("   [2] PULL  (PRODUÇÃO ➜ LOCAL)   [Baixa o banco do Coolify para o seu PC]")
        print("-" * 66)
        try:
            choice = input("👉 Escolha uma opção (1 ou 2) [padrão: 1]: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nOperação cancelada.")
            sys.exit(0)

        if choice in ("2", "pull", "p"):
            is_pull = True
        else:
            is_pull = False
        print()
    else:
        # Ambiente robô/não-interativo sem direção explícita
        print("ℹ️  Modo não-interativo detectado: assumindo direção padrão PUSH (LOCAL ➜ PRODUÇÃO).")
        print("    (Para alterar, passe --pull na linha de comando ou defina SYNC_DIRECTION=pull no .env)")
        is_pull = False

    # Define origem/destino conforme o sentido
    if is_pull:
        direction = "PRODUÇÃO ➜ LOCAL"
        src_url, dst_url = prod_url, local_url
        src_label, dst_label = "PRODUÇÃO", "LOCAL"
        env_exclude = env_list("SYNC_PULL_EXCLUDE_TABLES", "") or env_list("SYNC_EXCLUDE_TABLES", "")
        delete_missing = not args.no_delete  # PULL = espelho completo por padrão
        backup_dir, backup_prefix = ROOT / "backups_local", "local"
    else:
        direction = "LOCAL ➜ PRODUÇÃO"
        src_url, dst_url = local_url, prod_url
        src_label, dst_label = "LOCAL", "PRODUÇÃO"
        env_exclude = env_list("SYNC_EXCLUDE_TABLES", "")
        delete_missing = env_bool("SYNC_DELETE_MISSING", True) and not args.no_delete
        backup_dir, backup_prefix = ROOT / "backups_prod", "prod"

    if args.exclude:
        exclude = {t.strip() for t in args.exclude.split(",") if t.strip()}
    else:
        exclude = set(env_exclude)

    print("=" * 66)
    print(f" SGA 360° • Sincronização {direction}")
    print("=" * 66)
    print(f" Raiz da aplicação: {ROOT}")
    print(f" Origem  ({src_label.lower()}): {mask_url(src_url)}")
    print(f" Destino ({dst_label.lower()}): {mask_url(dst_url)}")
    print(f" Modo           : {'ESPELHO (insere/atualiza/remove)' if delete_missing else 'INCREMENTAL (insere/atualiza)'}")
    print(f" Ignoradas      : {', '.join(sorted(exclude)) or '-'}")
    print("-" * 66)

    src = connect(src_url, src_label)
    dst = connect(dst_url, dst_label)
    scur, dcur = src.cursor(), dst.cursor()

    try:
        tables = [t for t in list_tables(scur) if t not in exclude]
        if args.tables:
            wanted = {t.strip() for t in args.tables.split(",") if t.strip()}
            tables = [t for t in tables if t in wanted]
        tables = topo_sort(tables, get_fk_dependencies(scur))

        if not tables:
            print("ℹ️  Nenhuma tabela para sincronizar.")
            return

        # 1. Estrutura
        schema_actions = plan_schema(scur, dcur, tables)
        dst_tables = set(list_tables(dcur))

        # 2. Dados
        diffs = [diff_table(scur, dcur, t, t in dst_tables) for t in tables]
        if not delete_missing:
            for d in diffs:
                d["deletes"] = []

        # Resumo
        print("\n📐 Estrutura:")
        if schema_actions:
            for desc, _ in schema_actions:
                print(f"   + {desc}")
        else:
            print("   ✓ Estrutura já alinhada.")

        print("\n📊 Dados:")
        print(f"   {'TABELA':<28}{'NOVOS':>8}{'ALTERADOS':>11}{'REMOVIDOS':>11}")
        total_changes = 0
        for d in diffs:
            if d["skipped"]:
                print(f"   {d['table']:<28}  (ignorada: {d['skipped']})")
                continue
            n_del = len(d["deletes"])
            total_changes += d["inserts"] + d["updates"] + n_del
            print(f"   {d['table']:<28}{d['inserts']:>8}{d['updates']:>11}{n_del:>11}")

        if not schema_actions and total_changes == 0:
            print(f"\n✅ {dst_label.capitalize()} já está idêntico(a) a {src_label.lower()}. Nada a fazer.")
            return

        if args.dry_run:
            print("\n🔎 Modo --dry-run: nenhuma alteração foi aplicada.")
            return

        # 4. Confirmação (Sem travas para automação)
        auto_confirm = args.yes or env_bool("SYNC_AUTO_CONFIRM", False) or env_bool("SYNC_YES", False)

        if not auto_confirm:
            if not is_interactive:
                print("\n❌ Execução em modo não-interativo (robô/automação) detectada sem confirmação.")
                print("   Para executar alterações automaticamente, passe o parâmetro --yes (-y) ou defina SYNC_AUTO_CONFIRM=true no .env.")
                sys.exit(1)

            aviso = ""
            if "usuarios" not in exclude:
                if is_pull:
                    aviso = "\n   (os USUÁRIOS locais serão substituídos pelos da produção, incluindo senhas)"
                else:
                    aviso = "\n   (os USUÁRIOS da produção serão atualizados a partir do banco local)"
            try:
                resp = input(f"\n⚠️  Aplicar estas alterações no banco {dst_label}?{aviso}\n"
                             f"   Digite 'sim' para confirmar: ")
            except (KeyboardInterrupt, EOFError):
                print("\nOperação cancelada.")
                return

            if resp.strip().lower() not in ("sim", "s", "yes", "y"):
                print("🚫 Operação cancelada. Nenhuma alteração foi feita.")
                return

        backup_path = write_backup(diffs, backup_dir, backup_prefix)
        try:
            rel_backup = backup_path.relative_to(ROOT)
        except ValueError:
            rel_backup = backup_path
        print(f"\n💾 Backup das tabelas afetadas ({dst_label}): {rel_backup}")

        # 3. Aplica tudo em uma única transação no destino
        for desc, stmt in schema_actions:
            dcur.execute(stmt)

        # Tenta desativar temporariamente as FKs (exige superusuário); se não puder,
        # segue respeitando a ordem de dependências.
        dcur.execute("SAVEPOINT sga_replica")
        try:
            dcur.execute("SET LOCAL session_replication_role = replica")
            dcur.execute("RELEASE SAVEPOINT sga_replica")
        except psycopg2.Error:
            dcur.execute("ROLLBACK TO SAVEPOINT sga_replica")

        for d in reversed(diffs):  # filhos primeiro
            if not d["skipped"]:
                apply_deletes(dcur, d)
        for d in diffs:  # pais primeiro
            if not d["skipped"]:
                apply_upserts(dcur, d)
                reset_sequences(dcur, d["table"], d["columns"])

        dst.commit()
        print(f"\n✅ Sincronização concluída com sucesso! Banco {dst_label} atualizado a partir de {src_label}.")

    except Exception as exc:  # noqa: BLE001
        dst.rollback()
        print(f"\n❌ Erro durante a sincronização. Nenhuma alteração foi aplicada (rollback).\n   {exc}")
        sys.exit(1)
    finally:
        scur.close()
        dcur.close()
        src.close()
        dst.close()


if __name__ == "__main__":
    main()
