#!/usr/bin/env python3
"""
EcoSync Bot • Motor de Backup Seguro & Integração Google Drive (Conta Pessoal OAuth2 / Service Account)
- Empacota snapshots com metadados + checksum SHA-256 + compressão Gzip
- Criptografia Client-Side Zero-Knowledge AES-256-GCM antes do upload
- Proteção local de tokens e chaves via Windows DPAPI (CryptProtectData)
"""

from __future__ import annotations

import base64
import contextlib
import ctypes
import ctypes.wintypes as wintypes
import datetime as dt
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from google.auth.transport.requests import AuthorizedSession, Request
from google.oauth2 import service_account
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/drive.file"]
ENC_MAGIC = b"ESBK01"
DUMP_ENC_MAGIC = b"ESDM01"
DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files"
DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files"
DRIVE_ABOUT_URL = "https://www.googleapis.com/drive/v3/about"


def _mask_pg_error(text: str) -> str:
    return re.sub(r"(postgres(?:ql)?://[^:\s]+:)([^@\s]+)(@)", r"\1****\3", text or "")


def find_pg_tool(tool_name: str) -> str | None:
    """Localiza pg_dump / pg_restore mesmo se não estiver no PATH do Windows."""
    pg_bin_env = os.environ.get("PG_BIN_DIR", "").strip()
    if pg_bin_env:
        cand = Path(pg_bin_env) / (f"{tool_name}.exe" if os.name == "nt" else tool_name)
        if cand.exists():
            return str(cand)

    on_path = shutil.which(tool_name)
    if on_path:
        return on_path

    if os.name == "nt":
        candidates: list[tuple[int, Path]] = []
        for base in (Path(r"C:\Program Files\PostgreSQL"), Path(r"C:\Program Files (x86)\PostgreSQL")):
            if not base.exists():
                continue
            for ver_dir in base.iterdir():
                if not ver_dir.is_dir():
                    continue
                exe = ver_dir / "bin" / f"{tool_name}.exe"
                if exe.exists():
                    try:
                        ver_num = int(re.match(r"(\d+)", ver_dir.name).group(1))
                    except Exception:
                        ver_num = 0
                    candidates.append((ver_num, exe))
        if candidates:
            candidates.sort(key=lambda item: item[0], reverse=True)
            return str(candidates[0][1])
    return None


def _decode_proc_bytes(raw: bytes | None) -> str:
    if not raw:
        return ""
    for enc in ("utf-8", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def create_pg_dump(db_url: str, dump_path: Path) -> dict[str, Any]:
    """Gera snapshot binário consistente (pg_dump -Fc: DDL, FKs, índices, triggers, tabelas sem PK e dados)."""
    pg_dump_bin = find_pg_tool("pg_dump")
    if not pg_dump_bin:
        return {"success": False, "error": "pg_dump não encontrado no sistema."}
    if not db_url:
        return {"success": False, "error": "URL do banco não informada."}

    dump_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        pg_dump_bin,
        "--format=custom",
        "--compress=6",
        "--no-owner",
        "--no-acl",
        "--file", str(dump_path),
        "--dbname", db_url,
    ]
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=180, creationflags=flags)
        if proc.returncode != 0 or not dump_path.exists() or dump_path.stat().st_size == 0:
            try:
                if dump_path.exists():
                    dump_path.unlink()
            except Exception:
                pass
            err_msg = _decode_proc_bytes(proc.stderr) or _decode_proc_bytes(proc.stdout) or "pg_dump falhou."
            return {"success": False, "error": _mask_pg_error(err_msg)}

        raw = dump_path.read_bytes()
        return {
            "success": True,
            "dump_path": str(dump_path),
            "filename": dump_path.name,
            "size_kb": round(len(raw) / 1024, 2),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "tool": pg_dump_bin,
        }
    except Exception as exc:
        return {"success": False, "error": _mask_pg_error(str(exc))}


def restore_pg_dump(db_url: str, dump_path: Path) -> dict[str, Any]:
    """Restaura snapshot completo (DDL + dados) em transação única via pg_restore."""
    pg_restore_bin = find_pg_tool("pg_restore")
    if not pg_restore_bin:
        return {"success": False, "error": "pg_restore não encontrado no sistema."}
    if not dump_path.exists():
        return {"success": False, "error": f"Arquivo .dump não encontrado: {dump_path.name}"}

    cmd = [
        pg_restore_bin,
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-acl",
        "--single-transaction",
        "--exit-on-error",
        "--dbname", db_url,
        str(dump_path),
    ]
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=300, creationflags=flags)
        if proc.returncode != 0:
            err_msg = _decode_proc_bytes(proc.stderr) or _decode_proc_bytes(proc.stdout) or "pg_restore falhou."
            return {"success": False, "error": _mask_pg_error(err_msg)}
        return {"success": True, "filename": dump_path.name}
    except Exception as exc:
        return {"success": False, "error": _mask_pg_error(str(exc))}


def get_data_root(default_root: Path | None = None) -> Path:
    env_dir = os.environ.get("ECOSYNC_DATA_DIR")
    if env_dir:
        return Path(env_dir).resolve()
    if default_root is not None:
        return Path(default_root).resolve()
    return Path(__file__).resolve().parent


# --------------------------------------------------------------------------
# Windows DPAPI (Proteção de credenciais vinculadas ao usuário Windows local)
# --------------------------------------------------------------------------
class _DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


def _dpapi_protect(raw_bytes: bytes) -> bytes:
    if os.name != "nt":
        return raw_bytes
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    blob_in = _DATA_BLOB(len(raw_bytes), ctypes.create_string_buffer(raw_bytes, len(raw_bytes)))
    blob_out = _DATA_BLOB()
    if not crypt32.CryptProtectData(ctypes.byref(blob_in), "EcoSyncCloud", None, None, None, 0, ctypes.byref(blob_out)):
        raise OSError("Falha ao criptografar credenciais via Windows DPAPI.")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


def _dpapi_unprotect(enc_bytes: bytes) -> bytes:
    if os.name != "nt":
        return enc_bytes
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    blob_in = _DATA_BLOB(len(enc_bytes), ctypes.create_string_buffer(enc_bytes, len(enc_bytes)))
    blob_out = _DATA_BLOB()
    if not crypt32.CryptUnprotectData(ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)):
        raise OSError("Falha ao descriptografar credenciais via Windows DPAPI.")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


def _secrets_path(root: Path) -> Path:
    return root / "gdrive_secrets.dpapi"


def _cloud_index_path(root: Path) -> Path:
    return root / "logs" / "cloud_index.json"


def _default_secrets() -> dict[str, Any]:
    return {
        "auth_mode": "oauth2",
        "client_id": "",
        "client_secret": "",
        "service_account_info": None,
        "token_info": None,
        "root_folder_name": "EcoSync_Backups",
        "auto_upload": True,
        "encrypt_backups": True,
        "encryption_key": base64.urlsafe_b64encode(os.urandom(32)).decode("ascii"),
        "keep_local": 15,
    }


def load_cloud_secrets(root: Path) -> dict[str, Any]:
    p = _secrets_path(root)
    base = _default_secrets()
    if not p.exists():
        return base
    try:
        raw = _dpapi_unprotect(p.read_bytes())
        data = json.loads(raw.decode("utf-8"))
        if isinstance(data, dict):
            base.update(data)
            if not base.get("encryption_key"):
                base["encryption_key"] = base64.urlsafe_b64encode(os.urandom(32)).decode("ascii")
            return base
    except Exception:
        pass
    return base


def save_cloud_secrets(root: Path, data: dict[str, Any]) -> None:
    p = _secrets_path(root)
    raw = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
    p.write_bytes(_dpapi_protect(raw))


def load_cloud_index(root: Path) -> dict[str, Any]:
    p = _cloud_index_path(root)
    if not p.exists():
        return {"uploaded": {}}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("uploaded"), dict):
            return data
    except Exception:
        pass
    return {"uploaded": {}}


def save_cloud_index(root: Path, index: dict[str, Any]) -> None:
    p = _cloud_index_path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")


# --------------------------------------------------------------------------
# Normalização de Backups (v1 plano e v2 completo com metadados + SHA-256)
# --------------------------------------------------------------------------
def extract_backup_tables(data: Any) -> tuple[dict[str, list], dict[str, Any]]:
    if isinstance(data, dict) and isinstance(data.get("tables"), dict):
        return data["tables"], (data.get("meta") if isinstance(data.get("meta"), dict) else {})
    if isinstance(data, dict):
        tables = {k: v for k, v in data.items() if isinstance(v, list)}
        return tables, {}
    return {}, {}


def compute_tables_sha256(tables: dict[str, list]) -> str:
    canonical = json.dumps(tables, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def verify_backup_integrity(data: Any) -> dict[str, Any]:
    tables, meta = extract_backup_tables(data)
    expected = meta.get("sha256")
    is_full = bool(meta.get("full_snapshot", False))
    if not expected:
        return {"has_checksum": False, "valid": None, "is_full": is_full, "meta": meta}
    actual = compute_tables_sha256(tables)
    return {
        "has_checksum": True,
        "valid": (actual == expected),
        "is_full": is_full,
        "meta": meta,
    }


def _decode_aes_key(key_b64: str) -> bytes:
    raw = base64.urlsafe_b64decode(key_b64.strip().encode("ascii"))
    if len(raw) != 32:
        raise ValueError("Chave AES-256 inválida (esperados 32 bytes).")
    return raw


def encrypt_backup_payload(raw_bytes: bytes, key_b64: str, compress: bool = True) -> bytes:
    key = _decode_aes_key(key_b64)
    nonce = os.urandom(12)
    if compress:
        data_to_enc = gzip.compress(raw_bytes, compresslevel=6)
        magic = ENC_MAGIC
    else:
        data_to_enc = raw_bytes
        magic = DUMP_ENC_MAGIC
    ct = AESGCM(key).encrypt(nonce, data_to_enc, magic)
    return magic + nonce + ct


def decrypt_backup_payload(blob: bytes, key_b64: str) -> bytes:
    if blob.startswith(ENC_MAGIC):
        if len(blob) < len(ENC_MAGIC) + 12 + 16:
            raise ValueError("Arquivo criptografado corrompido ou truncado.")
        key = _decode_aes_key(key_b64)
        nonce = blob[len(ENC_MAGIC):len(ENC_MAGIC) + 12]
        ct = blob[len(ENC_MAGIC) + 12:]
        gz_bytes = AESGCM(key).decrypt(nonce, ct, ENC_MAGIC)
        return gzip.decompress(gz_bytes)
    if blob.startswith(DUMP_ENC_MAGIC):
        if len(blob) < len(DUMP_ENC_MAGIC) + 12 + 16:
            raise ValueError("Arquivo .dump criptografado corrompido ou truncado.")
        key = _decode_aes_key(key_b64)
        nonce = blob[len(DUMP_ENC_MAGIC):len(DUMP_ENC_MAGIC) + 12]
        ct = blob[len(DUMP_ENC_MAGIC) + 12:]
        return AESGCM(key).decrypt(nonce, ct, DUMP_ENC_MAGIC)
    if blob[:2] == b"\x1f\x8b":
        return gzip.decompress(blob)
    return blob


# --------------------------------------------------------------------------
# Autenticação & Sessão Google Drive
# --------------------------------------------------------------------------
def _build_credentials(root: Path, secrets: dict[str, Any]):
    mode = secrets.get("auth_mode") or "oauth2"
    if mode == "service_account":
        sa_info = secrets.get("service_account_info")
        if not sa_info:
            return None, "Arquivo JSON da Conta de Serviço não configurado."
        creds = service_account.Credentials.from_service_account_info(sa_info, scopes=SCOPES)
        return creds, None

    tok = secrets.get("token_info")
    if not tok:
        return None, "Conta Google pessoal ainda não conectada (clique em Conectar Conta Google)."

    creds = Credentials.from_authorized_user_info(tok, SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        secrets["token_info"] = json.loads(creds.to_json())
        save_cloud_secrets(root, secrets)
    elif not creds.valid:
        return None, "Sessão Google expirada sem refresh token. Reconecte sua conta Google."
    return creds, None


def get_cloud_status(root: Path, check_remote: bool = False, include_sensitive: bool = False) -> dict[str, Any]:
    secrets = load_cloud_secrets(root)
    index = load_cloud_index(root)

    key = secrets.get("encryption_key") or ""
    masked_key = f"{key[:6]}...{key[-4:]}" if len(key) > 12 else "****"
    has_oauth_client = bool(secrets.get("client_id") and secrets.get("client_secret"))
    has_sa = bool(secrets.get("service_account_info"))
    has_token = bool(secrets.get("token_info"))
    connected_local = has_token if secrets.get("auth_mode") == "oauth2" else has_sa

    out: dict[str, Any] = {
        "success": True,
        "auth_mode": secrets.get("auth_mode", "oauth2"),
        "has_client_config": has_oauth_client or has_sa,
        "client_id": secrets.get("client_id", "") if include_sensitive else "",
        "client_secret_masked": "••••••••" if secrets.get("client_secret") else "",
        "root_folder_name": secrets.get("root_folder_name") or "EcoSync_Backups",
        "auto_upload": bool(secrets.get("auto_upload", True)),
        "encrypt_backups": bool(secrets.get("encrypt_backups", True)),
        "keep_local": int(secrets.get("keep_local", 15)),
        "encryption_key_masked": masked_key,
        "encryption_key": key if include_sensitive else "",
        "connected": connected_local,
        "uploaded_count": len(index.get("uploaded", {})),
        "user_email": None,
        "quota_used_gb": None,
        "quota_limit_gb": None,
        "remote_error": None,
    }

    if check_remote and connected_local:
        try:
            creds, err = _build_credentials(root, secrets)
            if err:
                out["connected"] = False
                out["remote_error"] = err
                return out
            session = AuthorizedSession(creds)
            resp = session.get(
                DRIVE_ABOUT_URL,
                params={"fields": "user(displayName,emailAddress),storageQuota(limit,usage)"},
                timeout=10,
            )
            if resp.status_code == 200:
                info = resp.json()
                user = info.get("user") or {}
                quota = info.get("storageQuota") or {}
                out["connected"] = True
                out["user_email"] = user.get("emailAddress") or user.get("displayName")
                usage = int(quota.get("usage") or 0)
                limit = int(quota.get("limit") or 0)
                out["quota_used_gb"] = round(usage / (1024 ** 3), 2)
                out["quota_limit_gb"] = round(limit / (1024 ** 3), 2) if limit else None
            else:
                out["connected"] = False
                out["remote_error"] = f"Google Drive respondeu HTTP {resp.status_code}"
        except Exception as exc:
            out["remote_error"] = str(exc)

    return out


def save_cloud_config(root: Path, payload: dict[str, Any]) -> dict[str, Any]:
    secrets = load_cloud_secrets(root)
    if "auth_mode" in payload and payload["auth_mode"] in ("oauth2", "service_account"):
        secrets["auth_mode"] = payload["auth_mode"]

    if payload.get("oauth_json_raw"):
        try:
            parsed = json.loads(payload["oauth_json_raw"])
            node = parsed.get("installed") or parsed.get("web") or parsed
            cid = (node.get("client_id") or "").strip()
            csec = (node.get("client_secret") or "").strip()
            if not cid or not csec:
                return {"success": False, "error": "JSON OAuth inválido: faltam client_id ou client_secret."}
            secrets["auth_mode"] = "oauth2"
            secrets["client_id"] = cid
            secrets["client_secret"] = csec
        except Exception as exc:
            return {"success": False, "error": f"Falha ao ler JSON OAuth: {exc}"}

    if payload.get("service_account_json_raw"):
        try:
            parsed = json.loads(payload["service_account_json_raw"])
            if parsed.get("type") != "service_account" or not parsed.get("private_key"):
                return {"success": False, "error": "JSON não é uma Conta de Serviço válida."}
            secrets["auth_mode"] = "service_account"
            secrets["service_account_info"] = parsed
        except Exception as exc:
            return {"success": False, "error": f"Falha ao ler JSON da Conta de Serviço: {exc}"}

    if isinstance(payload.get("client_id"), str) and payload["client_id"].strip():
        secrets["client_id"] = payload["client_id"].strip()
    if isinstance(payload.get("client_secret"), str) and payload["client_secret"].strip():
        secrets["client_secret"] = payload["client_secret"].strip()

    if isinstance(payload.get("root_folder_name"), str) and payload["root_folder_name"].strip():
        clean_name = re.sub(r'[\\/:*?"<>|]+', "_", payload["root_folder_name"].strip())[:64]
        secrets["root_folder_name"] = clean_name or "EcoSync_Backups"

    if "auto_upload" in payload:
        secrets["auto_upload"] = bool(payload["auto_upload"])
    if "encrypt_backups" in payload:
        secrets["encrypt_backups"] = bool(payload["encrypt_backups"])
    if "keep_local" in payload:
        secrets["keep_local"] = max(3, min(100, int(payload["keep_local"] or 15)))

    if isinstance(payload.get("encryption_key"), str) and payload["encryption_key"].strip():
        try:
            _decode_aes_key(payload["encryption_key"].strip())
            secrets["encryption_key"] = payload["encryption_key"].strip()
        except Exception:
            return {"success": False, "error": "Chave de criptografia inválida (deve ser AES-256 em Base64 URL-safe)."}

    save_cloud_secrets(root, secrets)
    return get_cloud_status(root, check_remote=False, include_sensitive=True)


def connect_google_drive(root: Path) -> dict[str, Any]:
    secrets = load_cloud_secrets(root)
    if secrets.get("auth_mode") == "service_account":
        return get_cloud_status(root, check_remote=True, include_sensitive=False)

    cid = (secrets.get("client_id") or "").strip()
    csec = (secrets.get("client_secret") or "").strip()
    if not cid or not csec:
        return {
            "success": False,
            "error": "Configure primeiro o Client ID e Client Secret (ou importe o arquivo client_secret_*.json do Google Cloud).",
        }

    client_config = {
        "installed": {
            "client_id": cid,
            "client_secret": csec,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost"],
        }
    }

    try:
        flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
        with contextlib.redirect_stdout(sys.stderr):
            creds = flow.run_local_server(
                port=0,
                prompt="consent",
                access_type="offline",
                open_browser=True,
                authorization_prompt_message=None,
                timeout_seconds=180,
                success_message="EcoSync Bot autorizado no Google Drive! Voce ja pode fechar esta aba e voltar ao aplicativo.",
            )
        secrets["token_info"] = json.loads(creds.to_json())
        save_cloud_secrets(root, secrets)
        return get_cloud_status(root, check_remote=True, include_sensitive=False)
    except Exception as exc:
        return {"success": False, "error": f"Falha na autorização Google OAuth2: {exc}"}


def disconnect_google_drive(root: Path) -> dict[str, Any]:
    secrets = load_cloud_secrets(root)
    secrets["token_info"] = None
    save_cloud_secrets(root, secrets)
    return {"success": True}


# --------------------------------------------------------------------------
# Operações de Pastas, Upload & Download no Google Drive
# --------------------------------------------------------------------------
def _escape_q(val: str) -> str:
    return val.replace("\\", "\\\\").replace("'", "\\'")


def _find_or_create_folder(session: AuthorizedSession, name: str, parent_id: str | None = None) -> str:
    clauses = [
        f"name = '{_escape_q(name)}'",
        "mimeType = 'application/vnd.google-apps.folder'",
        "trashed = false",
    ]
    if parent_id:
        clauses.append(f"'{_escape_q(parent_id)}' in parents")

    resp = session.get(
        DRIVE_FILES_URL,
        params={
            "q": " and ".join(clauses),
            "fields": "files(id, name)",
            "pageSize": 5,
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        },
        timeout=15,
    )
    resp.raise_for_status()
    files = resp.json().get("files") or []
    if files:
        return files[0]["id"]

    meta: dict[str, Any] = {
        "name": name,
        "mimeType": "application/vnd.google-apps.folder",
    }
    if parent_id:
        meta["parents"] = [parent_id]

    create_resp = session.post(
        DRIVE_FILES_URL,
        params={"fields": "id", "supportsAllDrives": "true"},
        json=meta,
        timeout=15,
    )
    create_resp.raise_for_status()
    return create_resp.json()["id"]


def _extract_month_from_filename(filename: str) -> str:
    m = re.search(r"(\d{4})(\d{2})\d{2}_\d{6}", filename)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    return dt.datetime.now().strftime("%Y-%m")


def _upload_single_artifact(session: AuthorizedSession, root: Path, secrets: dict[str, Any], folder: str, src_path: Path) -> dict[str, Any]:
    filename = src_path.name
    is_dump = filename.endswith(".dump")
    raw_bytes = src_path.read_bytes()
    sha_plain = hashlib.sha256(raw_bytes).hexdigest()
    encrypt_on = bool(secrets.get("encrypt_backups", True))

    if encrypt_on:
        payload_bytes = encrypt_backup_payload(raw_bytes, secrets["encryption_key"], compress=(not is_dump))
        cloud_name = f"{filename}.enc" if is_dump else f"{filename}.gz.enc"
        mime = "application/octet-stream"
    else:
        payload_bytes = raw_bytes if is_dump else gzip.compress(raw_bytes, compresslevel=6)
        cloud_name = filename if is_dump else f"{filename}.gz"
        mime = "application/octet-stream" if is_dump else "application/gzip"

    root_name = secrets.get("root_folder_name") or "EcoSync_Backups"
    month_name = _extract_month_from_filename(filename)

    root_id = _find_or_create_folder(session, root_name, None)
    env_id = _find_or_create_folder(session, folder, root_id)
    month_id = _find_or_create_folder(session, month_name, env_id)

    q = f"name = '{_escape_q(cloud_name)}' and '{_escape_q(month_id)}' in parents and trashed = false"
    existing = session.get(
        DRIVE_FILES_URL,
        params={"q": q, "fields": "files(id, name, size)", "supportsAllDrives": "true", "includeItemsFromAllDrives": "true"},
        timeout=15,
    )
    existing.raise_for_status()
    existing_files = existing.json().get("files") or []

    if existing_files:
        file_id = existing_files[0]["id"]
    else:
        meta = {
            "name": cloud_name,
            "parents": [month_id],
            "appProperties": {
                "ecosync_env": folder,
                "ecosync_month": month_name,
                "ecosync_sha256": sha_plain,
                "ecosync_encrypted": "aes256gcm" if encrypt_on else ("raw" if is_dump else "gzip"),
                "ecosync_kind": "dump" if is_dump else "json",
                "ecosync_orig_name": filename,
            },
        }
        boundary = f"ecosync_{os.urandom(8).hex()}"
        part_meta = (
            f"--{boundary}\r\n"
            f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
            f"{json.dumps(meta)}\r\n"
        ).encode("utf-8")
        part_media_hdr = (
            f"--{boundary}\r\n"
            f"Content-Type: {mime}\r\n\r\n"
        ).encode("utf-8")
        closing = f"\r\n--{boundary}--\r\n".encode("utf-8")
        body = part_meta + part_media_hdr + payload_bytes + closing

        up_resp = session.post(
            DRIVE_UPLOAD_URL,
            params={"uploadType": "multipart", "fields": "id, name, size", "supportsAllDrives": "true"},
            headers={"Content-Type": f"multipart/related; boundary={boundary}"},
            data=body,
            timeout=120,
        )
        if up_resp.status_code == 403 and "storageQuotaExceeded" in up_resp.text:
            return {
                "success": False,
                "error": "Cota de armazenamento negada pelo Google (Service Account não possui Drive pessoal). Use OAuth2 para conta Gmail pessoal.",
            }
        up_resp.raise_for_status()
        file_id = up_resp.json()["id"]

    index = load_cloud_index(root)
    index["uploaded"][f"{folder}/{filename}"] = {
        "drive_id": file_id,
        "cloud_name": cloud_name,
        "month": month_name,
        "encrypted": encrypt_on,
        "kind": "dump" if is_dump else "json",
        "sha256": sha_plain,
        "compressed_kb": round(len(payload_bytes) / 1024, 2),
        "uploaded_at": dt.datetime.now().isoformat(),
    }
    save_cloud_index(root, index)

    return {
        "success": True,
        "folder": folder,
        "filename": filename,
        "cloud_name": cloud_name,
        "drive_id": file_id,
        "encrypted": encrypt_on,
        "kind": "dump" if is_dump else "json",
        "compressed_kb": round(len(payload_bytes) / 1024, 2),
    }


def upload_backup_file(root: Path, folder: str, filename: str) -> dict[str, Any]:
    if folder not in ("prod", "local"):
        return {"success": False, "error": "Pasta inválida."}
    if not filename or Path(filename).name != filename or not filename.endswith((".json", ".dump")):
        return {"success": False, "error": "Nome de arquivo inválido."}

    src_path = (root / f"backups_{folder}" / filename).resolve()
    if not src_path.exists():
        return {"success": False, "error": f"Arquivo local não encontrado: {filename}"}

    secrets = load_cloud_secrets(root)
    creds, err = _build_credentials(root, secrets)
    if err:
        return {"success": False, "error": err}

    try:
        session = AuthorizedSession(creds)
        res = _upload_single_artifact(session, root, secrets, folder, src_path)
        if not res.get("success"):
            return res

        # Se existir um .dump emparelhado ao .json, envia também automaticamente
        if filename.endswith(".json"):
            paired_dump = src_path.with_suffix(".dump")
            if paired_dump.exists():
                dump_res = _upload_single_artifact(session, root, secrets, folder, paired_dump)
                res["dump_uploaded"] = bool(dump_res.get("success"))
                res["dump_cloud_name"] = dump_res.get("cloud_name")
        return res
    except Exception as exc:
        return {"success": False, "error": f"Erro no upload Google Drive: {exc}"}


def sync_all_pending(root: Path) -> dict[str, Any]:
    index = load_cloud_index(root)
    uploaded_map = index.get("uploaded", {})
    uploaded_now = 0
    errors = []

    for folder in ("prod", "local"):
        bdir = root / f"backups_{folder}"
        if not bdir.exists():
            continue
        all_files = sorted(
            list(bdir.glob("*.json")) + list(bdir.glob("*.dump")),
            key=lambda f: f.stat().st_mtime,
        )
        for p in all_files:
            key = f"{folder}/{p.name}"
            if key in uploaded_map:
                continue
            res = upload_backup_file(root, folder, p.name)
            if res.get("success"):
                uploaded_now += 1
                uploaded_map = load_cloud_index(root).get("uploaded", {})
            else:
                errors.append(f"{p.name}: {res.get('error')}")
                if len(errors) >= 3:
                    break
        if len(errors) >= 3:
            break

    return {
        "success": len(errors) == 0 or uploaded_now > 0,
        "uploaded_count": uploaded_now,
        "errors": errors,
    }


def list_drive_backups(root: Path) -> dict[str, Any]:
    secrets = load_cloud_secrets(root)
    creds, err = _build_credentials(root, secrets)
    if err:
        return {"success": False, "error": err, "files": []}

    try:
        session = AuthorizedSession(creds)
        resp = session.get(
            DRIVE_FILES_URL,
            params={
                "q": "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
                "orderBy": "createdTime desc",
                "pageSize": 100,
                "fields": "files(id, name, size, createdTime, appProperties)",
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
            },
            timeout=15,
        )
        resp.raise_for_status()
        items = []
        for f in resp.json().get("files") or []:
            props = f.get("appProperties") or {}
            if not (props.get("ecosync_orig_name") or f["name"].endswith((".json.gz.enc", ".json.gz", ".dump.enc", ".dump"))):
                continue
            kind = props.get("ecosync_kind") or ("dump" if ".dump" in f["name"] else "json")
            orig = props.get("ecosync_orig_name") or re.sub(r"(\.gz)?\.enc$|\.gz$", "", f["name"])
            items.append({
                "drive_id": f["id"],
                "cloud_name": f["name"],
                "orig_name": orig,
                "kind": kind,
                "env": props.get("ecosync_env") or ("prod" if f["name"].startswith("prod") else "local"),
                "month": props.get("ecosync_month") or "",
                "encrypted": props.get("ecosync_encrypted", "aes256gcm") == "aes256gcm",
                "sha256": props.get("ecosync_sha256", ""),
                "size_kb": round(int(f.get("size") or 0) / 1024, 2),
                "created_at": f.get("createdTime", ""),
            })
        return {"success": True, "files": items}
    except Exception as exc:
        return {"success": False, "error": str(exc), "files": []}


def download_drive_backup(root: Path, drive_id: str, target_folder: str = "prod", recovery_key: str = "") -> dict[str, Any]:
    if not drive_id or not re.match(r"^[a-zA-Z0-9_-]+$", drive_id):
        return {"success": False, "error": "ID do arquivo Drive inválido."}
    if target_folder not in ("prod", "local"):
        return {"success": False, "error": "Pasta de destino inválida."}

    secrets = load_cloud_secrets(root)
    creds, err = _build_credentials(root, secrets)
    if err:
        return {"success": False, "error": err}

    try:
        session = AuthorizedSession(creds)
        meta_resp = session.get(
            f"{DRIVE_FILES_URL}/{drive_id}",
            params={"fields": "id, name, appProperties", "supportsAllDrives": "true"},
            timeout=15,
        )
        meta_resp.raise_for_status()
        meta = meta_resp.json()
        props = meta.get("appProperties") or {}
        kind = props.get("ecosync_kind") or ("dump" if ".dump" in meta["name"] else "json")
        orig_name = Path(props.get("ecosync_orig_name") or re.sub(r"(\.gz)?\.enc$|\.gz$", "", meta["name"])).name
        if kind == "dump" and not orig_name.endswith(".dump"):
            orig_name += ".dump"
        elif kind != "dump" and not orig_name.endswith(".json"):
            orig_name += ".json"

        dl_resp = session.get(
            f"{DRIVE_FILES_URL}/{drive_id}",
            params={"alt": "media", "supportsAllDrives": "true"},
            timeout=120,
        )
        dl_resp.raise_for_status()

        use_key = (recovery_key or "").strip() or (secrets.get("encryption_key") or "")
        plain_bytes = decrypt_backup_payload(dl_resp.content, use_key)

        expected_sha = props.get("ecosync_sha256")
        if expected_sha and hashlib.sha256(plain_bytes).hexdigest() != expected_sha:
            return {"success": False, "error": "Falha de integridade SHA-256 após descriptografar o snapshot."}

        if kind != "dump":
            json.loads(plain_bytes.decode("utf-8"))

        dst_dir = root / f"backups_{target_folder}"
        dst_dir.mkdir(parents=True, exist_ok=True)
        dst_path = dst_dir / orig_name
        dst_path.write_bytes(plain_bytes)

        return {
            "success": True,
            "folder": target_folder,
            "filename": orig_name,
            "kind": kind,
            "size_kb": round(len(plain_bytes) / 1024, 2),
        }
    except Exception as exc:
        return {"success": False, "error": f"Falha ao baixar/descriptografar do Drive: {exc}"}
