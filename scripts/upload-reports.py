"""Upload one generated LINSC Markdown/PDF report pair over verified SFTP."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import posixpath
import re
import shlex
import sys
import uuid


WORKSPACE = Path(__file__).resolve().parents[1]
LOCAL_DEPENDENCIES = WORKSPACE / "work" / "python-deps"
if LOCAL_DEPENDENCIES.is_dir():
    sys.path.insert(0, str(LOCAL_DEPENDENCIES))

try:
    import paramiko
except ModuleNotFoundError as error:
    raise SystemExit("缺少Paramiko。请先运行：npm run setup:python") from error


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upload one LINSC report pair")
    parser.add_argument("--date", required=True, help="YYYY-MM-DD")
    parser.add_argument("--report-dir", default=str(WORKSPACE / "public" / "reports"))
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


args = parse_args()
if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.date):
    raise SystemExit("交易日必须使用YYYY-MM-DD格式")

host = os.environ.get("LINSC_UPLOAD_HOST", "43.134.1.133")
username = os.environ.get("LINSC_UPLOAD_USER", "root")
remote_dir = os.environ.get("LINSC_UPLOAD_DIR", "/root/linsc-astock/reports")
password_file = Path(os.environ.get("LINSC_UPLOAD_PASSWORD_FILE", str(WORKSPACE / "key.txt")))
known_hosts = Path(os.environ.get("LINSC_UPLOAD_KNOWN_HOSTS", str(WORKSPACE / "config" / "ssh_known_hosts")))
report_dir = Path(args.report_dir)
reports = [report_dir / f"{args.date}.md", report_dir / f"{args.date}.pdf"]

for report in reports:
    if not report.is_file():
        raise FileNotFoundError(f"缺少本地报告：{report}")
if not password_file.is_file():
    raise FileNotFoundError(f"缺少服务器密码文件：{password_file}")
if not known_hosts.is_file():
    raise FileNotFoundError(f"缺少服务器主机密钥文件：{known_hosts}")

password = password_file.read_text(encoding="utf-8").rstrip("\r\n")
if not password:
    raise RuntimeError("服务器密码文件为空")

client = paramiko.SSHClient()
client.load_host_keys(str(known_hosts))
client.set_missing_host_key_policy(paramiko.RejectPolicy())
client.connect(
    host,
    username=username,
    password=password,
    look_for_keys=False,
    allow_agent=False,
    timeout=15,
    auth_timeout=15,
    banner_timeout=15,
)
password = None

try:
    with client.open_sftp() as sftp:
        sftp.chdir(remote_dir)
        for report in reports:
            destination = posixpath.join(remote_dir, report.name)
            temporary = f"{destination}.uploading-{uuid.uuid4().hex}"
            try:
                sftp.put(str(report), temporary, confirm=True)
                if sftp.stat(temporary).st_size != report.stat().st_size:
                    raise RuntimeError(f"上传大小不一致：{report.name}")
                sftp.posix_rename(temporary, destination)
            except Exception:
                try:
                    sftp.remove(temporary)
                except OSError:
                    pass
                raise

    names = " ".join(shlex.quote(report.name) for report in reports)
    command = f"cd {shlex.quote(remote_dir)} && sha256sum -- {names}"
    _, stdout, stderr = client.exec_command(command)
    remote_hashes = {}
    for line in stdout.read().decode("utf-8").splitlines():
        digest, name = line.split(maxsplit=1)
        remote_hashes[name.lstrip("*")] = digest
    error = stderr.read().decode("utf-8").strip()
    if error:
        raise RuntimeError(error)

    for report in reports:
        if remote_hashes.get(report.name) != sha256(report):
            raise RuntimeError(f"远程哈希校验失败：{report.name}")
        print(f"Uploaded and verified: {report.name} ({report.stat().st_size} bytes)")
finally:
    client.close()
