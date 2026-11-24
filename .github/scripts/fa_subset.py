#!/usr/bin/env python3
"""Rehace fonts/ con solo los íconos de Font Awesome 6.5.2 que usa el sitio.
Uso: python3 fa_subset.py <carpeta paquete npm fontawesome-free> <repo> <lista de clases fa-*>
Después cambia ?v= en index.html y fonts/fa-subset.css. Si falta un ícono, index.html carga Font Awesome completo solo."""
import re,sys,os,json
from fontTools import subset
pkg,repo,usedfile=sys.argv[1:4]
used=set(open(usedfile).read().split())
mods={'fa-solid','fa-regular','fa-brands','fa-spin','fa-beat','fa-fw'}
css=open(f'{pkg}/css/all.min.css').read()
css=re.sub(r'/\*.*?\*/','',css,flags=re.S)
# split top-level rules
out=[];cps=set();i=0;rules=[]
depth=0;start=0
for j,ch in enumerate(css):
    if ch=='{':depth+=1
    elif ch=='}':
        depth-=1
        if depth==0: rules.append(css[start:j+1]);start=j+1
kept_icons=set()
for r in rules:
    sel,body=r.split('{',1)
    m=re.fullmatch(r'\s*(?:\.fa-[a-z0-9-]+:{1,2}before,?)+\s*',sel)
    if m and 'content' in body:
        names=re.findall(r'\.(fa-[a-z0-9-]+):',sel)
        keep=[n for n in names if n in used]
        if not keep: continue
        cp=re.search(r'content:"\\([0-9a-f]+)"',body)
        if cp: cps.add(int(cp.group(1),16))
        kept_icons.update(keep)
        out.append(','.join(f'.{n}:before' for n in keep)+'{'+body)
        continue
    if '@font-face' in sel:
        if 'v4compat' in body: continue
        body=re.sub(r'src:[^;}]*',lambda m:'src:url(/fonts/'+re.search(r'(fa-[a-z]+-\d+)\.woff2',m.group(0)).group(1)+'.woff2) format("woff2")',body)
        body=body.replace('font-display:block','font-display:swap')
        out.append(sel+'{'+body);continue
    # v4 shims / other icon-unrelated rules
    out.append(r)
res=''.join(out)
os.makedirs(f'{repo}/fonts',exist_ok=True)
open(f'{repo}/fonts/fa-subset.css','w').write(res)
for f in ['fa-solid-900','fa-regular-400','fa-brands-400']:
    o=subset.Options();o.flavor='woff2';o.layout_features=['*'];o.desc=False
    font=subset.load_font(f'{pkg}/webfonts/{f}.woff2',o)
    s=subset.Subsetter(o);s.populate(unicodes=cps);s.subset(font)
    subset.save_font(font,f'{repo}/fonts/{f}.woff2',o)
missing=sorted(used-kept_icons-mods)
print('icons',len(kept_icons),'cps',len(cps),'css',len(res),'missing',missing)
json.dump(sorted(kept_icons),open(f'{repo}/fonts/fa-subset.json','w'))
