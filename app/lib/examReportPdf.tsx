// FILE: app/lib/examReportPdf.tsx
// Generic tabular PDF for exam analytics reports (class result,
// subject performance, topper list, fail list, grade distribution,
// exam attendance). One renderer, many datasets - the report-pdf route
// builds columns/rows per report type. Portrait A4, Helvetica, print
// friendly. Mirrors app/lib/staffReportPdf.tsx.

import React from 'react'
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'

export interface ExamReportColumn {
  key: string
  label: string
  width: number            // percent of usable width
  align?: 'left' | 'right' | 'center'
}

export interface ExamReportDoc {
  schoolName: string
  title: string
  subtitle: string
  generatedAt: string
  summary: { label: string; value: string }[]
  columns: ExamReportColumn[]
  rows: Record<string, string>[]
}

const BORDER = '#94a3b8'
const HEAD = '#e2e8f0'
const ZEBRA = '#f5f7fa'
const INK = '#1e293b'
const MUTED = '#64748b'

const s = StyleSheet.create({
  page: { paddingVertical: 26, paddingHorizontal: 28, fontFamily: 'Helvetica', color: INK, fontSize: 9 },
  school: { fontSize: 15, fontFamily: 'Helvetica-Bold' },
  title: { fontSize: 11, fontFamily: 'Helvetica-Bold', marginTop: 6 },
  sub: { fontSize: 9, color: MUTED, marginTop: 1 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 },
  gen: { fontSize: 8, color: MUTED },
  rule: { height: 2, backgroundColor: INK, marginBottom: 8 },
  summary: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginBottom: 10, paddingVertical: 6, paddingHorizontal: 8, borderWidth: 1, borderColor: BORDER, borderRadius: 3 },
  sItem: { flexDirection: 'row', gap: 4 },
  sLabel: { color: MUTED },
  sValue: { fontFamily: 'Helvetica-Bold' },
  th: { flexDirection: 'row', backgroundColor: HEAD, borderTopWidth: 1, borderBottomWidth: 1, borderColor: BORDER },
  tr: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#e2e8f0' },
  trAlt: { backgroundColor: ZEBRA },
  cell: { paddingVertical: 3.5, paddingHorizontal: 4, borderRightWidth: 1, borderColor: '#e2e8f0' },
  cellFirst: { borderLeftWidth: 1, borderColor: '#e2e8f0' },
  hCell: { fontFamily: 'Helvetica-Bold', fontSize: 8.5, color: INK },
  footer: { position: 'absolute', bottom: 12, left: 28, right: 28, flexDirection: 'row', justifyContent: 'space-between' },
  fText: { fontSize: 7.5, color: MUTED },
})

function Report({ doc }: { doc: ExamReportDoc }) {
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <Text style={s.school}>{doc.schoolName}</Text>
        <Text style={s.title}>{doc.title}</Text>
        <View style={s.metaRow}>
          <Text style={s.sub}>{doc.subtitle}</Text>
          <Text style={s.gen}>Generated {doc.generatedAt}</Text>
        </View>
        <View style={s.rule} />

        {doc.summary.length > 0 && (
          <View style={s.summary}>
            {doc.summary.map((it, i) => (
              <View key={i} style={s.sItem}>
                <Text style={s.sLabel}>{it.label}</Text>
                <Text style={s.sValue}>{it.value}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={s.th}>
          {doc.columns.map((c, i) => (
            <Text key={c.key} style={[s.cell, i === 0 ? s.cellFirst : {}, s.hCell,
              { width: `${c.width}%`, textAlign: c.align ?? 'left' }]}>{c.label}</Text>
          ))}
        </View>
        {doc.rows.map((row, ri) => (
          <View key={ri} style={[s.tr, ri % 2 === 1 ? s.trAlt : {}]}>
            {doc.columns.map((c, ci) => (
              <Text key={c.key} style={[s.cell, ci === 0 ? s.cellFirst : {},
                { width: `${c.width}%`, textAlign: c.align ?? 'left' }]}>{row[c.key] ?? ''}</Text>
            ))}
          </View>
        ))}

        <View style={s.footer} fixed>
          <Text style={s.fText}>Schoolium — Exam report</Text>
          <Text style={s.fText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

export async function renderExamReportPdfBuffer(doc: ExamReportDoc): Promise<Buffer> {
  return renderToBuffer(<Report doc={doc} />)
}
