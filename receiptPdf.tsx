// Single-page A4 fee receipt as a real PDF, for sending to parents on WhatsApp.
//
// This is the PARENT-FACING receipt: ONE full-page copy with all details, as
// opposed to the two-copy print layout in receipt.ts (which is optimised to fit
// two students per A4 sheet for the office printer).
//
// SINGLE SOURCE OF TRUTH: it consumes the exact same ReceiptInput used by the
// print HTML and reuses shortAddress() + amountInWords() from receipt.ts. Only
// the medium differs - print needs HTML, WhatsApp needs a real PDF file.
//
// Rendered server-side by the outbox worker (Node runtime) via
// renderReceiptPdfBuffer(). @react-pdf/renderer's built-in Helvetica has no
// Indian Rupee glyph, so amounts use the "Rs." prefix (standard on Indian
// receipts) - no font bundling required.

import React from 'react'
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer'
import {
  ReceiptInput,
  ReceiptLineInput,
  shortAddress,
  amountInWords,
} from './receipt'

// ---- brand tokens (mirrors the blues used in the print receipt) -------------
const BLUE = '#1e3a8a'
const BLUE2 = '#2563eb'
const BLUE_SOFT = '#eff6ff'
const BLUE_BORDER = '#bfdbfe'
const SLATE = '#1e293b'
const SLATE_MUTED = '#64748b'
const SLATE_FAINT = '#94a3b8'
const LINE = '#e2e8f0'
const GREEN = '#16a34a'
const AMBER = '#b45309'
const AMBER_BG = '#fffbeb'
const AMBER_BORDER = '#fde68a'

function rs(n: number): string {
  return 'Rs. ' + Math.round(n).toLocaleString('en-IN')
}

const styles = StyleSheet.create({
  page: {
    paddingVertical: 30,
    paddingHorizontal: 34,
    fontFamily: 'Helvetica',
    color: SLATE,
    fontSize: 10,
  },
  frame: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    padding: 20,
  },

  // header
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  schoolName: { fontSize: 19, fontFamily: 'Helvetica-Bold', color: BLUE },
  schoolContact: { fontSize: 8.5, color: SLATE_MUTED, marginTop: 3 },
  paidBadge: {
    backgroundColor: GREEN,
    color: '#ffffff',
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 2,
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 5,
  },
  accent: { height: 3, backgroundColor: BLUE2, borderRadius: 2, marginTop: 12 },

  // title strip
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginTop: 14,
    marginBottom: 12,
  },
  title: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 3,
    color: SLATE,
  },
  metaRight: { alignItems: 'flex-end' },
  metaReceiptNo: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: BLUE },
  metaDate: { fontSize: 8.5, color: SLATE_MUTED, marginTop: 2 },

  // details card
  card: {
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 8,
    padding: 12,
    flexDirection: 'row',
    marginBottom: 14,
  },
  col: { flex: 1, paddingRight: 10 },
  dRow: { flexDirection: 'row', marginBottom: 5 },
  dLabel: { width: 62, fontSize: 8.5, color: SLATE_MUTED },
  dValue: { flex: 1, fontSize: 9.5, fontFamily: 'Helvetica-Bold', color: SLATE },
  mono: { fontFamily: 'Courier' },

  // fee table
  tableHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
    paddingBottom: 4,
    marginBottom: 2,
  },
  thL: { fontSize: 8, color: SLATE_FAINT, letterSpacing: 0.5 },
  thR: { fontSize: 8, color: SLATE_FAINT, letterSpacing: 0.5 },
  sectionHead: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: SLATE_MUTED,
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 2,
    textTransform: 'uppercase',
  },
  lineRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 3,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  lineLabel: { fontSize: 9.5, color: SLATE, flex: 1, paddingRight: 8 },
  lineAmt: { fontSize: 9.5, fontFamily: 'Helvetica-Bold', color: SLATE },
  annDisc: { fontSize: 7.5, color: GREEN },
  annLate: { fontSize: 7.5, color: AMBER },

  // totals
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
    paddingTop: 5,
    borderTopWidth: 1,
    borderTopColor: LINE,
  },
  totalLabel: { fontSize: 10, color: SLATE_MUTED },
  totalValue: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: SLATE },

  paidBox: {
    backgroundColor: BLUE_SOFT,
    borderWidth: 1,
    borderColor: BLUE_BORDER,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginTop: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  paidLabel: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: BLUE2,
    letterSpacing: 0.5,
  },
  paidValue: { fontSize: 17, fontFamily: 'Helvetica-Bold', color: BLUE },
  words: { fontSize: 8.5, color: '#475569', fontStyle: 'italic', marginTop: 5 },

  balance: {
    marginTop: 8,
    fontSize: 9,
    color: AMBER,
    backgroundColor: AMBER_BG,
    borderWidth: 1,
    borderColor: AMBER_BORDER,
    borderRadius: 4,
    paddingVertical: 5,
    paddingHorizontal: 8,
  },

  // signature + footer
  sigRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 26 },
  sigBox: { alignItems: 'center', width: 150 },
  sigLine: { borderTopWidth: 1, borderTopColor: '#475569', width: '100%' },
  sigText: { fontSize: 8, color: SLATE_MUTED, marginTop: 3 },
  footer: {
    marginTop: 18,
    textAlign: 'center',
    fontSize: 7.5,
    color: SLATE_FAINT,
    lineHeight: 1.5,
  },
})

function LineRow({ l }: { l: ReceiptLineInput }) {
  const disc = l.discount_amount && l.discount_amount > 0
  const late = l.late_fee_amount && l.late_fee_amount > 0
  return (
    <View style={styles.lineRow} wrap={false}>
      <Text style={styles.lineLabel}>
        {l.label}
        {disc ? <Text style={styles.annDisc}>{'  (-' + rs(l.discount_amount as number) + ' disc)'}</Text> : null}
        {late ? <Text style={styles.annLate}>{'  (+' + rs(l.late_fee_amount as number) + ' late)'}</Text> : null}
      </Text>
      <Text style={styles.lineAmt}>{rs(l.amount)}</Text>
    </View>
  )
}

function Section({ title, rows }: { title: string; rows: ReceiptLineInput[] }) {
  if (rows.length === 0) return null
  return (
    <View>
      <Text style={styles.sectionHead}>{title}</Text>
      {rows.map((l, i) => <LineRow key={i} l={l} />)}
    </View>
  )
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.dRow}>
      <Text style={styles.dLabel}>{label}</Text>
      <Text style={[styles.dValue, ...(mono ? [styles.mono] : [])]}>{value}</Text>
    </View>
  )
}

export function FeeReceiptPDF({ input }: { input: ReceiptInput }) {
  const { school, student, lines, amountPaid, method, grandBalance, generatedAt, receiptNumber } = input

  const dt = new Date(generatedAt).toLocaleString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  })
  const addr = shortAddress(student.address)
  const totalBilled = lines.reduce((s, l) => s + l.amount, 0)
  const currentLines = lines.filter(l => !l.is_arrear && !l.is_extra)
  const arrearLines = lines.filter(l => l.is_arrear)
  const extraLines = lines.filter(l => l.is_extra)
  const modeLabel = method.replace('_', ' ').toUpperCase()

  return (
    <Document title={'Fee Receipt' + (receiptNumber ? ' ' + receiptNumber : '')} author={school.name}>
      <Page size="A4" style={styles.page}>
        <View style={styles.frame}>
          {/* header */}
          <View style={styles.headerRow}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.schoolName}>{school.name}</Text>
              {school.phone ? <Text style={styles.schoolContact}>Phone: {school.phone}</Text> : null}
            </View>
            <Text style={styles.paidBadge}>PAID</Text>
          </View>
          <View style={styles.accent} />

          {/* title + receipt no */}
          <View style={styles.titleRow}>
            <Text style={styles.title}>FEE RECEIPT</Text>
            <View style={styles.metaRight}>
              {receiptNumber ? <Text style={styles.metaReceiptNo}>{receiptNumber}</Text> : null}
              <Text style={styles.metaDate}>{dt}</Text>
            </View>
          </View>

          {/* details */}
          <View style={styles.card}>
            <View style={styles.col}>
              <DetailRow label="Student" value={student.full_name} />
              {student.father_name ? <DetailRow label="Father" value={student.father_name} /> : null}
              <DetailRow label="Mode" value={modeLabel} />
            </View>
            <View style={styles.col}>
              {student.student_uid ? <DetailRow label="Student ID" value={student.student_uid} mono /> : null}
              {addr ? <DetailRow label="Address" value={addr} /> : null}
              <DetailRow label="Date & time" value={dt} />
            </View>
          </View>

          {/* fee table */}
          <View style={styles.tableHead}>
            <Text style={styles.thL}>FEE HEAD</Text>
            <Text style={styles.thR}>AMOUNT</Text>
          </View>
          <Section title="Current Month Dues" rows={currentLines} />
          <Section title="Previous Arrears" rows={arrearLines} />
          <Section title="Additional Fees" rows={extraLines} />

          {/* totals */}
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total billed</Text>
            <Text style={styles.totalValue}>{rs(totalBilled)}</Text>
          </View>

          <View style={styles.paidBox}>
            <Text style={styles.paidLabel}>AMOUNT PAID</Text>
            <Text style={styles.paidValue}>{rs(amountPaid)}</Text>
          </View>
          <Text style={styles.words}>({amountInWords(amountPaid)})</Text>

          {grandBalance > 0 ? (
            <Text style={styles.balance}>
              Outstanding balance after this payment: {rs(grandBalance)}
            </Text>
          ) : null}

          {/* signature */}
          <View style={styles.sigRow}>
            <View style={styles.sigBox}>
              <View style={styles.sigLine} />
              <Text style={styles.sigText}>Authorized Signature</Text>
            </View>
          </View>

          <Text style={styles.footer}>
            This is your official fee receipt. Please retain it for your records.{'\n'}
            {school.name}{school.phone ? '  |  ' + school.phone : ''}  |  Computer-generated receipt
          </Text>
        </View>
      </Page>
    </Document>
  )
}

// Render the receipt to a PDF Buffer (Node runtime only - used by the worker).
export async function renderReceiptPdfBuffer(input: ReceiptInput): Promise<Buffer> {
  return await renderToBuffer(<FeeReceiptPDF input={input} />)
}
