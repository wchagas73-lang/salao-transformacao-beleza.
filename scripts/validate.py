from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]

def check_js(source: str, label: str) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8", delete=False) as handle:
        handle.write(source)
        path = handle.name
    result = subprocess.run(["node", "--check", path], capture_output=True, text=True)
    Path(path).unlink(missing_ok=True)
    if result.returncode:
        raise SystemExit(f"JavaScript inválido em {label}:\n{result.stderr}")
    print(f"OK JavaScript: {label}")

api = ROOT / "functions" / "api" / "[[path]].js"
check_js(api.read_text(encoding="utf-8"), str(api.relative_to(ROOT)))

for html_name in ("index.html", "admin.html"):
    html = (ROOT / html_name).read_text(encoding="utf-8")
    scripts = re.findall(r"<script[^>]*>(.*?)</script>", html, flags=re.S | re.I)
    if not scripts:
        raise SystemExit(f"Nenhum script inline encontrado em {html_name}")
    for index, script in enumerate(scripts, start=1):
        check_js(script, f"{html_name} script {index}")

db = sqlite3.connect(":memory:")
schema = (ROOT / "database" / "schema.sql").read_text(encoding="utf-8")
db.executescript(schema)
service_count = db.execute("SELECT COUNT(*) FROM services").fetchone()[0]
if service_count != 7:
    raise SystemExit(f"Esperados 7 serviços iniciais, encontrados {service_count}")
tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
required = {"services", "appointments", "blocked_periods", "salon_settings", "admin_login_attempts"}
if not required.issubset(tables):
    raise SystemExit(f"Tabelas ausentes: {sorted(required - tables)}")
print("OK SQL: schema executado e tabelas/serviços verificados")
