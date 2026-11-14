import re,subprocess,sys,pathlib
root=pathlib.Path(sys.argv[1]).resolve(); deps=pathlib.Path(sys.argv[2]).resolve(); deps.mkdir(exist_ok=True)
NEW={"noir-bignum@zkp":"","noir-bignum":"v0.11.0","noir_base64":"v0.5.1","nodash":"v0.46.0","sha256":"v0.3.0","poseidon":"v0.4.0","noir_rsa":"v0.7.0","keccak256":"v0.1.3"}
line=re.compile(r'^(\s*[\w-]+\s*=\s*)\{([^}]*)\}', re.M)
def fix(toml):
  t=toml.read_text()
  def rep(m):
    body=m.group(2); g=re.search(r'git\s*=\s*"([^"]+)"',body)
    if not g: return m.group(0)
    url=g.group(1); name=url.rstrip("/").split("/")[-1]
    tag=(None if "zkpassport" in url else NEW.get(name)) or re.search(r'tag\s*=\s*"([^"]+)"',body).group(1)
    sub=re.search(r'directory\s*=\s*"([^"]+)"',body)
    d=deps/f"{url.split('/')[-2]}-{name}@{tag}"
    if not d.exists():
      subprocess.run(["git","clone","-q","--depth","1","--branch",tag,url,str(d)],check=True,stderr=subprocess.DEVNULL)
      for f in list(d.rglob("Nargo.toml")): fix(f)
      for f in d.rglob("src/**/*.nr"):
        stem=f.with_suffix("")
        if f.name not in("lib.nr","main.nr","mod.nr") and stem.is_dir() and not (stem/"mod.nr").exists(): f.rename(stem/"mod.nr")
    p=d/(sub.group(1) if sub else "")
    return f'{m.group(1)}{{ path = "{p}" }}'
  t2=line.sub(rep,t)
  if t2!=t: toml.write_text(t2)
for toml in list(root.rglob("Nargo.toml")): fix(toml)
print(sorted(p.name for p in deps.iterdir()))
