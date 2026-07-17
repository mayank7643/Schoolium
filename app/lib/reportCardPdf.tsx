// FILE: app/lib/reportCardPdf.tsx
// Report card PDF, rendered STRICTLY from the report_cards.snapshot
// JSONB (never recomputed) so a reprint always matches the issued
// document. One card per A4 page. Helvetica only.

import React from 'react'
import { Document, Page, Text, View, Image, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import type { ReportCardSnapshot } from '@/types'

export interface ReportCardDoc {
  snapshot: ReportCardSnapshot
  qrDataUrl: string | null
  verifyNote: string
}

const INK = '#1e293b'
const MUTED = '#64748b'
const BORDER = '#94a3b8'
const HEAD = '#e2e8f0'

const s = StyleSheet.create({
  page: { padding: 30, fontFamily: 'Helvetica', color: INK, fontSize: 9 },
  border: { borderWidth: 1.5, borderColor: INK, borderRadius: 4, padding: 16, flexGrow: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1.5, borderColor: INK, paddingBottom: 8, marginBottom: 8 },
  logo: { width: 42, height: 42 },
  school: { fontSize: 17, fontFamily: 'Helvetica-Bold' },
  addr: { fontSize: 8, color: MUTED, marginTop: 1 },
  title: { textAlign: 'center', fontSize: 11, fontFamily: 'Helvetica-Bold', letterSpacing: 1, marginBottom: 8 },
  info: { flexDirection: 'row', gap: 12, marginBottom: 10 },
  photo: { width: 60, height: 72, objectFit: 'cover', borderWidth: 1, borderColor: BORDER },
  fields: { flex: 1 },
  fRow: { flexDirection: 'row', marginBottom: 2 },
  fLabel: { color: MUTED, width: 70 },
  fValue: { fontFamily: 'Helvetica-Bold', flex: 1 },
  th: { flexDirection: 'row', backgroundColor: HEAD, borderTopWidth: 1, borderBottomWidth: 1, borderColor: BORDER },
  tr: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#e2e8f0' },
  cell: { paddingVertical: 3, paddingHorizontal: 4, borderRightWidth: 1, borderColor: '#e2e8f0' },
  cellFirst: { borderLeftWidth: 1, borderColor: '#e2e8f0' },
  hCell: { fontFamily: 'Helvetica-Bold', fontSize: 8 },
  summary: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 10, padding: 8, borderWidth: 1, borderColor: BORDER, borderRadius: 3 },
  sItem: { flexDirection: 'row', gap: 4 },
  sLabel: { color: MUTED },
  sValue: { fontFamily: 'Helvetica-Bold' },
  remarks: { marginTop: 10, fontSize: 8.5 },
  foot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 18 },
  qr: { width: 56, height: 56 },
  sig: { borderTopWidth: 1, borderColor: INK, paddingTop: 2, width: 120, textAlign: 'center', color: MUTED, fontSize: 8 },
})

function num(v: number | null | undefined): string {
  return v === null || v === undefined ? '-' : String(v)
}

function ReportCardPdf({ doc }: { doc: ReportCardDoc }) {
  const { snapshot: snap } = doc
  const r = snap.result
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <View style={s.border}>
          <View style={s.head}>
            {snap.school.logo_url ? <Image src={snap.school.logo_url} style={s.logo} /> : null}
            <View style={{ flex: 1 }}>
              <Text style={s.school}>{snap.school.name}</Text>
              {snap.school.address ? <Text style={s.addr}>{snap.school.address}</Text> : null}
            </View>
          </View>
          <Text style={s.title}>REPORT CARD - {snap.exam.name.toUpperCase()}</Text>

          <View style={s.info}>
            {snap.student.photo_url
              ? <Image src={snap.student.photo_url} style={s.photo} />
              : <View style={[s.photo, { backgroundColor: '#f1f5f9' }]} />}
            <View style={s.fields}>
              <View style={s.fRow}><Text style={s.fLabel}>Name</Text><Text style={s.fValue}>{snap.student.full_name}</Text></View>
              <View style={s.fRow}><Text style={s.fLabel}>Class</Text><Text style={s.fValue}>{snap.student.class}</Text></View>
              <View style={s.fRow}><Text style={s.fLabel}>Roll No.</Text><Text style={s.fValue}>{String(snap.student.roll_number)}</Text></View>
              {snap.student.student_uid ? (
                <View style={s.fRow}><Text style={s.fLabel}>Student ID</Text><Text style={s.fValue}>{snap.student.student_uid}</Text></View>
              ) : null}
            </View>
          </View>

          {/* Subject table */}
          <View style={s.th}>
            <Text style={[s.cell, s.cellFirst, s.hCell, { width: '34%' }]}>Subject</Text>
            <Text style={[s.cell, s.hCell, { width: '14%', textAlign: 'center' }]}>Max</Text>
            <Text style={[s.cell, s.hCell, { width: '16%', textAlign: 'center' }]}>Obtained</Text>
            <Text style={[s.cell, s.hCell, { width: '18%', textAlign: 'center' }]}>Grade</Text>
            <Text style={[s.cell, s.hCell, { width: '18%', textAlign: 'center' }]}>Result</Text>
          </View>
          {snap.subjects.map((sub, i) => {
            const fail = !sub.is_absent && sub.total !== null && sub.total < sub.pass_marks
            return (
              <View key={i} style={s.tr}>
                <Text style={[s.cell, s.cellFirst, { width: '34%' }]}>{sub.subject}</Text>
                <Text style={[s.cell, { width: '14%', textAlign: 'center' }]}>{num(sub.max)}</Text>
                <Text style={[s.cell, { width: '16%', textAlign: 'center' }]}>{sub.is_absent ? 'AB' : num(sub.total)}</Text>
                <Text style={[s.cell, { width: '18%', textAlign: 'center' }]}>{sub.grade ?? '-'}</Text>
                <Text style={[s.cell, { width: '18%', textAlign: 'center' }]}>{sub.is_absent ? 'Absent' : fail ? 'Fail' : 'Pass'}</Text>
              </View>
            )
          })}

          {/* Summary */}
          <View style={s.summary}>
            <View style={s.sItem}><Text style={s.sLabel}>Total</Text><Text style={s.sValue}>{r.total_obtained} / {r.total_max}</Text></View>
            <View style={s.sItem}><Text style={s.sLabel}>Percentage</Text><Text style={s.sValue}>{r.percentage}%</Text></View>
            {r.grade ? <View style={s.sItem}><Text style={s.sLabel}>Grade</Text><Text style={s.sValue}>{r.grade}</Text></View> : null}
            {r.cgpa !== null ? <View style={s.sItem}><Text style={s.sLabel}>CGPA</Text><Text style={s.sValue}>{r.cgpa}</Text></View> : null}
            {r.rank !== null ? <View style={s.sItem}><Text style={s.sLabel}>Rank</Text><Text style={s.sValue}>{r.rank}</Text></View> : null}
            {r.attendance_percent !== null ? <View style={s.sItem}><Text style={s.sLabel}>Attendance</Text><Text style={s.sValue}>{r.attendance_percent}%</Text></View> : null}
            <View style={s.sItem}><Text style={s.sLabel}>Result</Text><Text style={[s.sValue, { color: r.status === 'pass' ? '#047857' : '#dc2626' }]}>{r.status.toUpperCase()}</Text></View>
          </View>

          {snap.remarks ? (
            <Text style={s.remarks}><Text style={{ fontFamily: 'Helvetica-Bold' }}>Class teacher remarks: </Text>{snap.remarks}</Text>
          ) : null}

          <View style={s.foot}>
            <View style={{ alignItems: 'center' }}>
              {doc.qrDataUrl ? <Image src={doc.qrDataUrl} style={s.qr} /> : null}
              <Text style={{ fontSize: 6, color: MUTED }}>{doc.verifyNote}</Text>
            </View>
            <Text style={s.sig}>Principal&apos;s Signature</Text>
          </View>
        </View>
      </Page>
    </Document>
  )
}

export async function renderReportCardPdfBuffer(doc: ReportCardDoc): Promise<Buffer> {
  return renderToBuffer(<ReportCardPdf doc={doc} />)
}

// Batch: many cards, one PDF (each on its own page)
function ReportCardsBatch({ docs }: { docs: ReportCardDoc[] }) {
  return (
    <Document>
      {docs.map((doc, i) => {
        const single = ReportCardPdf({ doc })
        // reuse single-page structure by mapping its page child
        return React.cloneElement(single.props.children as React.ReactElement, { key: i })
      })}
    </Document>
  )
}

export async function renderReportCardsBatchBuffer(docs: ReportCardDoc[]): Promise<Buffer> {
  return renderToBuffer(<ReportCardsBatch docs={docs} />)
}
