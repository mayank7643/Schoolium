// Shared fee-receipt builder used by both the collect page and the fees page,
// so the printed layout stays identical everywhere.
//
// Layout: two copies (Office + Student) side by side, each in a bordered box,
// occupying the TOP HALF of an A4 sheet. The lower half is left blank so the
// clerk can feed it back into the printer for the next student. Boxes sit a
// little inside the half so a slightly-short sheet does not clip the content.

export interface ReceiptLineInput {
  label: string
  amount: number
  is_arrear?: boolean
  is_extra?: boolean
  discount_amount?: number | null
  late_fee_amount?: number | null
}

export interface ReceiptInput {
  school: { name: string; phone?: string | null }
  student: {
    full_name: string
    student_uid?: string | null
    father_name?: string | null
    address?: string | null
  }
  lines: ReceiptLineInput[]
  amountPaid: number
  method: string
  grandBalance: number
  generatedAt: string      // ISO timestamp
  paidDate?: string        // accepted but unused (kept for call compatibility)
  receiptNumber?: string   // shown on the single-page PDF (WhatsApp); print HTML ignores it
}

// Short, privacy-friendly address: first 1-2 comma segments, length-capped.
export function shortAddress(addr: string | null | undefined): string {
  if (!addr) return ''
  const parts = addr.split(',').map(p => p.trim()).filter(Boolean)
  let out = parts.length > 1 ? parts.slice(0, 2).join(', ') : (parts[0] || '')
  if (out.length > 40) out = out.slice(0, 40).trimEnd() + '…'
  return out
}

// Amount in words, Indian numbering (whole rupees).
export function amountInWords(num: number): string {
  const n = Math.round(num)
  if (n === 0) return 'Zero Rupees Only'
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
    'Seventeen', 'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
  function twoDigit(x: number): string {
    if (x < 20) return ones[x]
    return tens[Math.floor(x / 10)] + (x % 10 ? ' ' + ones[x % 10] : '')
  }
  function threeDigit(x: number): string {
    const h = Math.floor(x / 100)
    const r = x % 100
    return (h ? ones[h] + ' Hundred' + (r ? ' ' : '') : '') + (r ? twoDigit(r) : '')
  }
  const crore = Math.floor(n / 10000000)
  const lakh  = Math.floor((n % 10000000) / 100000)
  const thousand = Math.floor((n % 100000) / 1000)
  const rest  = n % 1000
  let words = ''
  if (crore)    words += threeDigit(crore) + ' Crore '
  if (lakh)     words += twoDigit(lakh) + ' Lakh '
  if (thousand) words += twoDigit(thousand) + ' Thousand '
  if (rest)     words += threeDigit(rest) + ' '
  return words.trim() + ' Rupees Only'
}

export function buildReceiptHTML(input: ReceiptInput): string {
  const { school, student, lines, amountPaid, method, grandBalance, generatedAt } = input
  const formattedDateTime = new Date(generatedAt).toLocaleString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  })
  const addrShort = shortAddress(student.address)
  const totalBilled = lines.reduce((s, l) => s + l.amount, 0)
  const paidWords = amountInWords(amountPaid)

  const currentLines = lines.filter(l => !l.is_arrear && !l.is_extra)
  const arrearLines  = lines.filter(l => l.is_arrear)
  const extraLines   = lines.filter(l => l.is_extra)

  function lineRow(l: ReceiptLineInput) {
    const disc = l.discount_amount && l.discount_amount > 0
      ? ` <span style="color:#16a34a;font-size:7px">(-₹${l.discount_amount.toLocaleString('en-IN')} disc)</span>` : ''
    const late = l.late_fee_amount && l.late_fee_amount > 0
      ? ` <span style="color:#b45309;font-size:7px">(+₹${l.late_fee_amount.toLocaleString('en-IN')} late)</span>` : ''
    return `<tr>
      <td style="padding:2px 0;border-bottom:1px solid #f1f5f9;font-size:8.5px;color:#1e293b">${l.label}${disc}${late}</td>
      <td style="padding:2px 0;border-bottom:1px solid #f1f5f9;font-size:8.5px;text-align:right;font-weight:600;color:#1e293b">₹${l.amount.toLocaleString('en-IN')}</td>
    </tr>`
  }

  function section(title: string, rows: ReceiptLineInput[]) {
    if (rows.length === 0) return ''
    return `<tr><td colspan="2" style="padding:5px 0 1px;font-size:7px;font-weight:700;color:#64748b;letter-spacing:.5px;text-transform:uppercase">${title}</td></tr>
      ${rows.map(lineRow).join('')}`
  }

  function copy(label: string) {
    return `<div class="copy">
  <div class="bar"></div>
  <div class="school">${school.name}</div>
  ${school.phone ? `<div class="ph">Ph: ${school.phone}</div>` : ''}
  <div class="tag">${label}</div>
  <div class="rt">Fee Receipt</div>
  <div class="meta">
    <div class="mrow"><span class="ml">Student</span><span class="mv">${student.full_name}</span></div>
    ${student.student_uid ? `<div class="mrow"><span class="ml">ID</span><span class="mv mono">${student.student_uid}</span></div>` : ''}
    ${student.father_name ? `<div class="mrow"><span class="ml">Father</span><span class="mv">${student.father_name}</span></div>` : ''}
    ${addrShort ? `<div class="mrow"><span class="ml">Address</span><span class="mv">${addrShort}</span></div>` : ''}
    <div class="mrow"><span class="ml">Mode</span><span class="mv">${method.replace('_',' ').toUpperCase()}</span></div>
    <div class="mrow"><span class="ml">Date &amp; time</span><span class="mv">${formattedDateTime}</span></div>
  </div>
  <table>
    <thead><tr><th>Fee Head</th><th class="r">Amount</th></tr></thead>
    <tbody>
      ${section('Current Month Dues', currentLines)}
      ${section('Previous Arrears', arrearLines)}
      ${section('Additional Fees', extraLines)}
    </tbody>
  </table>
  <div class="totrow"><span>Total billed</span><span class="b">₹${totalBilled.toLocaleString('en-IN')}</span></div>
  <div class="box">
    <span class="pl">Paid Now</span>
    <span class="pv">₹${amountPaid.toLocaleString('en-IN')}</span>
  </div>
  <div class="words">(${paidWords})</div>
  ${grandBalance > 0 ? `<div class="bal">Outstanding balance after this payment: ₹${grandBalance.toLocaleString('en-IN')}</div>` : ''}
  <div class="sig"><div class="sigline">Authorized Signature</div></div>
  <div class="footer">${school.name}${school.phone ? ' · ' + school.phone : ''} · Computer-generated receipt</div>
</div>`
  }

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Fee Receipt</title>
<style>
@page { size: A4; margin: 6mm; }
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial,sans-serif;background:#fff;color:#1e293b}
/* Two bordered copies side by side in the TOP HALF. Capped well inside the
   half (130mm) with a gap and side padding so nothing is clipped on a slightly
   short sheet; the lower half stays blank for the next student. */
.sheet{display:flex;align-items:stretch;gap:4mm;padding:3mm 2mm 0}
.copy{flex:1;border:1.5px solid #cbd5e1;border-radius:10px;padding:6mm 5mm 5mm;max-height:130mm;overflow:hidden;background:#fff}
.vcut{flex:0 0 0;align-self:stretch;border-left:2px dashed #94a3b8;position:relative}
.vcut span{position:absolute;top:-3px;left:-7px;background:#fff;font-size:11px;color:#94a3b8}
.bar{background:#2563eb;height:4px;border-radius:2px;margin-bottom:6px}
.school{font-size:13px;font-weight:700;color:#1e3a8a;line-height:1.15}
.ph{font-size:8px;color:#64748b;margin-top:1px}
.tag{display:inline-block;font-size:8px;font-weight:700;color:#1d4ed8;border:1px solid #bfdbfe;background:#eff6ff;border-radius:3px;padding:1px 6px;letter-spacing:.5px;margin-top:4px}
.rt{font-size:7px;color:#64748b;letter-spacing:1.5px;text-transform:uppercase;margin:5px 0 4px;border-bottom:1px dashed #cbd5e1;padding-bottom:4px}
.meta{margin-bottom:5px}
.mrow{display:flex;justify-content:space-between;font-size:8.5px;padding:1px 0;gap:6px}
.ml{color:#64748b;white-space:nowrap}.mv{font-weight:600;text-align:right}.mono{font-family:monospace}
table{width:100%;border-collapse:collapse}
th{font-size:7px;color:#94a3b8;text-align:left;padding-bottom:2px}
th.r{text-align:right}
.totrow{display:flex;justify-content:space-between;font-size:9px;padding:3px 0;border-top:1px solid #e2e8f0;margin-top:2px}
.totrow .b{font-weight:700}
.box{background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:5px 9px;margin:6px 0 2px;display:flex;justify-content:space-between;align-items:center}
.pl{font-size:8px;color:#1d4ed8;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.pv{font-size:15px;font-weight:800;color:#1e3a8a}
.words{font-size:8px;color:#475569;font-style:italic;margin-bottom:3px}
.bal{font-size:8px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:4px;padding:3px 6px;margin-top:2px}
.sig{display:flex;justify-content:flex-end;margin-top:8px;padding-top:5px}
.sigline{border-top:1.5px solid #475569;width:95px;padding-top:3px;font-size:7px;color:#64748b;text-align:center}
.footer{margin-top:6px;text-align:center;font-size:7px;color:#94a3b8;line-height:1.4}
.hcut{border-top:2px dashed #94a3b8;text-align:center;height:0;margin-top:5mm}
.hcut span{position:relative;top:-9px;background:#fff;padding:0 10px;font-size:9px;color:#94a3b8}
@media print{.box,.tag,.bar{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<div class="sheet">
  ${copy('OFFICE COPY')}
  <div class="vcut"><span>✂</span></div>
  ${copy('STUDENT COPY')}
</div>
<div class="hcut"><span>✂ cut here — the lower half stays blank; feed it back in for the next student</span></div>
</body></html>`
}

// Print any receipt HTML via a throwaway hidden iframe.
export function printReceiptHTML(html: string): void {
  if (typeof window === 'undefined') return
  const iframe = document.createElement('iframe')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  iframe.title = 'receipt-print'
  document.body.appendChild(iframe)
  const doc = iframe.contentWindow?.document
  if (!doc) { iframe.remove(); return }
  doc.open()
  doc.write(html)
  doc.close()
  setTimeout(() => {
    iframe.contentWindow?.focus()
    iframe.contentWindow?.print()
    setTimeout(() => iframe.remove(), 1000)
  }, 350)
}
