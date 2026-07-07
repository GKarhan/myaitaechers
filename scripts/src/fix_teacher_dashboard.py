# -*- coding: utf-8 -*-
content = open('/home/runner/workspace/artifacts/myaiteacher/src/pages/teacher-dashboard.tsx', encoding='utf-8').read()

# 1. Fix student form grid (slice approach)
start = content.find('showStudentForm && (')
form_start = content.find('<div className="grid grid-cols-2 gap-3">', start)
form_end = content.find('</form>', start)
grid_section_end = content.rfind('</div>', form_start, form_end)

new_section = (
    '<div className="grid grid-cols-2 gap-3">\n'
    '                    <div className="col-span-2"><label className="text-xs text-muted-foreground">Անouн Аzganun *</label><input value={studentForm.fullName} onChange={e => setStudentForm(f => ({ ...f, fullName: e.target.value }))} required className={inputCls} placeholder="Аshakertи Аnunы" /></div>\n'
    '                    <div><label className="text-xs text-muted-foreground">Email</label><input type="email" value={(studentForm as any).email} onChange={e => setStudentForm(f => ({ ...f, email: e.target.value } as any))} className={inputCls} placeholder="example@mail.com" /></div>\n'
    '                    <div><label className="text-xs text-muted-foreground">Тariq (amix)</label><input type="number" min="5" max="25" value={(studentForm as any).age} onChange={e => setStudentForm(f => ({ ...f, age: e.target.value } as any))} className={inputCls} placeholder="14" /></div>\n'
    '                  </div>\n'
    '                  <p className="text-xs text-muted-foreground/70">Аlginabarн klini "student123", оgтanunы avtоmat kerpi</p>\n'
    '                  <div className="flex gap-2">\n'
    '                    <button type="submit" disabled={addStudent.isPending} className={btnPrimary}>{addStudent.isPending ? "..." : "Аvelacel"}</button>\n'
    '                    <button type="button" onClick={() => setShowStudentForm(false)} className="px-4 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white">Chegharkel</button>\n'
    '                  </div>'
)
content = content[:form_start] + new_section + content[grid_section_end+6:]

# 2. Fix handleAddStudent handler
idx = content.find('const handleAddStudent')
end = content.find('};', idx) + 2
new_handler = (
    'const handleAddStudent = (e: React.FormEvent) => {\n'
    '    e.preventDefault(); if (!selectedClass) return; setStudentError("");\n'
    '    addStudent.mutate({ classId: selectedClass.id, data: {\n'
    '      fullName: studentForm.fullName,\n'
    '      email: (studentForm as any).email || undefined,\n'
    '      age: (studentForm as any).age ? parseInt((studentForm as any).age) : undefined,\n'
    '    } as any }, {\n'
    '      onSuccess: () => { setShowStudentForm(false); setStudentForm({ fullName: "", email: "", age: "" } as any); qc.invalidateQueries({ queryKey: getGetClassStudentsQueryKey(selectedClass.id) }); },\n'
    '      onError: () => setStudentError("\u054d\u056d\u0561\u056c"),\n'
    '    });\n'
    '  };'
)
content = content[:idx] + new_handler + content[end:]

# 3. Fix student list — show email/age instead of username
content = content.replace(
    '                      <div className="text-xs text-muted-foreground">{s.username}</div>',
    '                      <div className="text-xs text-muted-foreground">{(s as any).email || s.username}{(s as any).age ? ` \u00b7 ${(s as any).age} t.` : ""}</div>'
)

# 4. Fix "Ashakert chka" empty state
content = content.replace(
    'Ashakert chka',
    '\u0531\u0577\u0561\u056f\u0565\u0580\u057f \u0579\u056f\u0561'
)

# 5. Remove unused DAYS_ORDER (find exact line)
import re
content = re.sub(r'\n  const DAYS_ORDER = \[[^\]]+\];\n', '\n', content)

open('/home/runner/workspace/artifacts/myaiteacher/src/pages/teacher-dashboard.tsx', 'w', encoding='utf-8').write(content)
print('Done')
c = open('/home/runner/workspace/artifacts/myaiteacher/src/pages/teacher-dashboard.tsx', encoding='utf-8').read()
print('username removed:', 'studentForm.username' not in c)
print('password removed:', 'studentForm.password' not in c)
print('email field added:', 'studentForm.email' in c or '(studentForm as any).email' in c)
