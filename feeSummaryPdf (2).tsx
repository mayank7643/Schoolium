// Server-side (Node) PDF for the school fee summary. A plain landscape table,
// black-and-white print friendly (light gray header + zebra, dark borders, no
// reliance on colour). Rendered by /api/fee-summary-pdf. Uses "Rs." because the
// built-in Helvetica has no rupee glyph.

import React from 'react'
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'

export interface FeeSummaryRow {
  student_uid: string | null
  full_name: string
  father_name: string | null
  parent_phone: string | null
  class_name: string | null
  section: string | null
  due_count: number
  outstanding: number
}

export interface FeeSummaryDoc {
  schoolName: string
  filterLabel: string
  generatedAt: string
  rows: FeeSummaryRow[]
  totals: { students: number; withDues: number; cleared: number; outstanding: number }
}

function rs(n: number) {
  return 'Rs. ' + Math.round(Number(n) || 0).toLocaleString('en-IN')
}

const BORDER = '#94a3b8'
const HEAD = '#e2e8f0'
const ZEBRA = '#f5f7fa'
const INK = '#1e293b'
const MUTED = '#64748b'

// column widths (points) for portrait A4 usable width (~547pt)
const W = { idx: 20, student: 128, father: 98, mobile: 78, cls: 40, dues: 32, out: 72, status: 54 }

const styles = StyleSheet.create({
  page: { paddingVertical: 26, paddingHorizontal: 28, fontFamily: 'Helvetica', color: INK, fontSize: 8.5 },
  school: { fontSize: 15, fontFamily: 'Helvetica-Bold' },
  sub: { fontSize: 9, color: MUTED, marginTop: 2 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 },
  rule: { height: 2, backgroundColor: INK, marginBottom: 8 },
  summary: {
    flexDirection: 'row', gap: 16, marginBottom: 10, paddingVertical: 6,
    paddingHorizontal: 8, borderWidth: 1, borderColor: BORDER, borderRadius: 3,
  },
  sItem: { flexDirection: 'row', gap: 4 },
  sLabel: { color: MUTED },
  sValue: { fontFamily: 'Helvetica-Bold' },

  th: { flexDirection: 'row', backgroundColor: HEAD, borderTopWidth: 1, borderBottomWidth: 1, borderColor: BORDER },
  tr: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#e2e8f0' },
  trAlt: { backgroundColor: ZEBRA },
  cell: { paddingVertical: 3.5, paddingHorizontal: 4, borderRightWidth: 1, borderColor: '#e2e8f0' },
  cellFirst: { borderLeftWidth: 1, borderColor: '#e2e8f0' },
  hCell: { fontFamily: 'Helvetica-Bold', fontSize: 8, color: INK },
  name: { fontSize: 8.5, color: INK },
  uid: { fontSize: 6.5, color: MUTED, fontFamily: 'Courier' },
  right: { textAlign: 'right' },
  center: { textAlign: 'center' },
  footer: { position: 'absolute', bottom: 14, left: 28, right: 28, flexDirection: 'row', justifyContent: 'space-between' },
  footText: { fontSize: 7, color: MUTED },
})

function Header({ doc }: { doc: FeeSummaryDoc }) {
  return (
    <View>
      <View style={styles.metaRow}>
        <View>
          <Text style={styles.school}>{doc.schoolName}</Text>
          <Text style={styles.sub}>Fee Summary — {doc.filterLabel}</Text>
        </View>
        <Text style={styles.sub}>{doc.generatedAt}</Text>
      </View>
      <View style={styles.rule} />
      <View style={styles.summary}>
        <View style={styles.sItem}><Text style={styles.sLabel}>Students:</Text><Text style={styles.sValue}>{doc.totals.students}</Text></View>
        <View style={styles.sItem}><Text style={styles.sLabel}>With dues:</Text><Text style={styles.sValue}>{doc.totals.withDues}</Text></View>
        <View style={styles.sItem}><Text style={styles.sLabel}>Cleared:</Text><Text style={styles.sValue}>{doc.totals.cleared}</Text></View>
        <View style={styles.sItem}><Text style={styles.sLabel}>Total outstanding:</Text><Text style={styles.sValue}>{rs(doc.totals.outstanding)}</Text></View>
      </View>
    </View>
  )
}

function TableHead() {
  return (
    <View style={styles.th} fixed>
      <View style={[styles.cell, styles.cellFirst, { width: W.idx }]}><Text style={[styles.hCell, styles.center]}>#</Text></View>
      <View style={[styles.cell, { width: W.student }]}><Text style={styles.hCell}>Student</Text></View>
      <View style={[styles.cell, { width: W.father }]}><Text style={styles.hCell}>Father</Text></View>
      <View style={[styles.cell, { width: W.mobile }]}><Text style={styles.hCell}>Mobile</Text></View>
      <View style={[styles.cell, { width: W.cls }]}><Text style={[styles.hCell, styles.center]}>Class</Text></View>
      <View style={[styles.cell, { width: W.dues }]}><Text style={[styles.hCell, styles.center]}>Dues</Text></View>
      <View style={[styles.cell, { width: W.out }]}><Text style={[styles.hCell, styles.right]}>Outstanding</Text></View>
      <View style={[styles.cell, { width: W.status }]}><Text style={[styles.hCell, styles.center]}>Status</Text></View>
    </View>
  )
}

function Row({ r, i }: { r: FeeSummaryRow; i: number }) {
  const cls = [r.class_name, r.section].filter(Boolean).join('-') || '—'
  const cleared = r.due_count === 0
  return (
    <View style={[styles.tr, ...(i % 2 === 1 ? [styles.trAlt] : [])]} wrap={false}>
      <View style={[styles.cell, styles.cellFirst, { width: W.idx }]}><Text style={styles.center}>{i + 1}</Text></View>
      <View style={[styles.cell, { width: W.student }]}>
        <Text style={styles.name}>{r.full_name}</Text>
        {r.student_uid ? <Text style={styles.uid}>{r.student_uid}</Text> : null}
      </View>
      <View style={[styles.cell, { width: W.father }]}><Text>{r.father_name || '—'}</Text></View>
      <View style={[styles.cell, { width: W.mobile }]}><Text>{r.parent_phone || '—'}</Text></View>
      <View style={[styles.cell, { width: W.cls }]}><Text style={styles.center}>{cls}</Text></View>
      <View style={[styles.cell, { width: W.dues }]}><Text style={styles.center}>{r.due_count}</Text></View>
      <View style={[styles.cell, { width: W.out }]}><Text style={styles.right}>{cleared ? '—' : rs(r.outstanding)}</Text></View>
      <View style={[styles.cell, { width: W.status }]}><Text style={styles.center}>{cleared ? 'Cleared' : 'Pending'}</Text></View>
    </View>
  )
}

export function FeeSummaryPDF({ doc }: { doc: FeeSummaryDoc }) {
  return (
    <Document title={`Fee Summary - ${doc.filterLabel}`} author={doc.schoolName}>
      <Page size="A4" style={styles.page}>
        <Header doc={doc} />
        <TableHead />
        {doc.rows.map((r, i) => <Row key={i} r={r} i={i} />)}
        {doc.rows.length === 0 && (
          <View style={{ padding: 20 }}><Text style={{ color: MUTED, textAlign: 'center' }}>No students match this filter.</Text></View>
        )}
        <View style={styles.footer} fixed>
          <Text style={styles.footText}>{doc.schoolName} — generated {doc.generatedAt}</Text>
          <Text style={styles.footText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

export async function renderFeeSummaryPdfBuffer(doc: FeeSummaryDoc): Promise<Buffer> {
  return await renderToBuffer(<FeeSummaryPDF doc={doc} />)
}
