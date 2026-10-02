"""Convert the private source DOCX to a private, one-time SQL seed.

Usage: python tools/import-employee-docx.py SOURCE.docx /PRIVATE/PATH/seed.sql
Never put the output in the repository: the original contains access codes.
Only standard-library packages are needed. Does not edit the source DOCX.
"""
import hashlib
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
from zipfile import ZipFile

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'

def convert(source):
    with ZipFile(source) as archive:
        root = ET.fromstring(archive.read('word/document.xml'))
        rels = {r.attrib['Id']: r.attrib['Target'] for r in ET.fromstring(archive.read('word/_rels/document.xml.rels'))}
    def inline(element):
        tag = element.tag.removeprefix(W)
        if tag == 't':
            return [{'type': 'text', 'text': element.text or ''}]
        if tag in ('br', 'cr'):
            return [{'type': 'br'}]
        if tag == 'tab':
            return [{'type': 'text', 'text': '\t'}]
        if tag in ('rPr', 'pPr', 'drawing', 'pict'):
            return []
        children = [node for child in element for node in inline(child)]
        if tag == 'r':
            props = element.find(W + 'rPr')
            if props is not None:
                for prop, kind in [('b', 'strong'), ('i', 'em'), ('u', 'u')]:
                    setting = props.find(W + prop)
                    if setting is not None and setting.get(W + 'val') not in ('0', 'false', 'none'):
                        children = [{'type': kind, 'children': children}]
        if tag == 'hyperlink':
            href = rels.get(element.get(R + 'id'), '')
            if href.lower().startswith(('https://', 'http://')):
                children = [{'type': 'a', 'href': href, 'children': children}]
        return children
    blocks = [{'type': 'logo'}]
    headings = {'Active employees:', 'Inactive employees:', 'Retired and/or quit employees:',
                'Password for employees to add links:', 'Community password:', 'Aarav passwords:',
                'website in development', 'maintenance times'}
    duplicates = 0
    for paragraph in root.find(W + 'body').findall(W + 'p'):
        children = inline(paragraph)
        cleaned = []
        for child in children:
            if cleaned and child.get('type') == 'a' and child == cleaned[-1]:
                duplicates += 1
                continue
            cleaned.append(child)
        text = ''.join(paragraph.itertext()).strip()
        if not text and not any(c['type'] == 'br' for c in cleaned):
            continue
        blocks.append({'type': 'h2' if text in headings else 'p', 'children': cleaned})
    return {'type': 'doc', 'children': blocks}, duplicates

if __name__ == '__main__':
    source, output = map(Path, sys.argv[1:3])
    repository = Path(__file__).resolve().parents[1]
    if output.resolve().is_relative_to(repository):
        raise SystemExit('Seed contains private employee codes. Choose an output outside the repository.')
    content, duplicates = convert(source)
    payload = json.dumps(content, ensure_ascii=False).replace("'", "''")
    output.write_text("""-- PRIVATE: contains the original employee document and access codes.
-- Run AFTER 20261002_employee_document.sql in the existing Supabase SQL Editor.
-- Never commit, publish, or place this seed on GitHub Pages.
-- Re-running never replaces an existing document or its saved revisions.
begin;
insert into public.employee_documents(id,content)
values ('employee', '""" + payload + """'::jsonb)
on conflict (id) do nothing;
insert into public.employee_document_revisions(revision,content,updated_at,updated_by)
select revision,content,updated_at,updated_by from public.employee_documents where id='employee'
on conflict (revision) do nothing;
commit;
""", encoding='utf-8')
    print(f'Created private seed; {len(content["children"])} blocks; {duplicates} duplicate adjacent links collapsed.')
    print('Source SHA256:', hashlib.sha256(source.read_bytes()).hexdigest())
