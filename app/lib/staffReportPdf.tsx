// FILE: app/lib/staffReportPdf.tsx
//
// Server-side (Node) generic table PDF for all staff reports
// (chat17 Module 8): directory, monthly attendance, leave, department
// and teacher assignments. One renderer, five datasets - the
// /api/staff-report-pdf route builds the columns/rows per report type.
// Portrait A4, black-and-white print friendly (light gray header +
// zebra rows, no reliance on colour), Helvetica only. Use "Rs." if a
// currency value ever appears - Helvetica has no rupee glyph.

import React from 'react'
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'

export interface ReportColumn {
  key: string
  label: string
  width: number            // points; usable portrait width is ~539pt
  align?: 'left' | 'right' | 'center'
}

export interface StaffReportDoc {
  schoolName: string
  title: string
  subtitle: string          // e.g. "July 2026" or "All departments"
  generatedAt: string
  summary: { label: string; value: string }[]
  columns: ReportColumn[]
  rows: Record<string, string>[]
}

const BORDER = '#94a3b8'
const HEAD = '#e2e8f0'
const ZEBRA = '#f5f7fa'
const INK = '#1e293b'
const MUTED = '#64748b'

const styles = StyleSheet.create({
  page: { paddingVertical: 26, paddingHorizontal: 28, fontFamily: 'Helvetica', color: INK, fontSize: 8.5 },
  school: { fontSize: 15, fontFamily: 'Helvetica-Bold' },
  sub: { fontSize: 9, color: MUTED, marginTop: 2 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 },
  gen: { fontSize: 8, color: MUTED },
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
  footer: {
    position: 'absolute', bottom: 12, left: 28, right: 28,
    flexDirection: 'row', justifyContent: 'space-between',
    fontSize: 7.5, color: MUTED,
  },
})

function alignStyle(a?: 'left' | 'right' | 'center') {
  return a === 'right' ? { textAlign: 'right' as const }
       : a === 'center' ? { textAlign: 'center' as const }
       : { textAlign: 'left' as const }
}

function ReportPdf({ doc }: { doc: StaffReportDoc }) {
  return (
    <Document title={`${doc.title} - ${doc.schoolName}`}>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.metaRow} fixed>
          <View>
            <Text style={styles.school}>{doc.schoolName}</Text>
            <Text style={styles.sub}>{doc.title} - {doc.subtitle}</Text>
          </View>
          <Text style={styles.gen}>Generated {doc.generatedAt}</Text>
        </View>
        <View style={styles.rule} fixed />

        {/* Summary strip */}
        {doc.summary.length > 0 && (
          <View style={styles.summary}>
            {doc.summary.map((s, i) => (
              <View key={i} style={styles.sItem}>
                <Text style={styles.sLabel}>{s.label}:</Text>
                <Text style={styles.sValue}>{s.value}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Table header (repeats on every page) */}
        <View style={styles.th} fixed>
          {doc.columns.map((c, i) => (
            <Text key={c.key}
              style={[styles.cell, styles.hCell, ...(i === 0 ? [styles.cellFirst] : []),
                      { width: c.width }, alignStyle(c.align)]}>
              {c.label}
            </Text>
          ))}
        </View>

        {/* Rows */}
        {doc.rows.map((row, ri) => (
          <View key={ri} style={[styles.tr, ...(ri % 2 === 1 ? [styles.trAlt] : [])]} wrap={false}>
            {doc.columns.map((c, i) => (
              <Text key={c.key}
                style={[styles.cell, ...(i === 0 ? [styles.cellFirst] : []),
                        { width: c.width }, alignStyle(c.align)]}>
                {row[c.key] ?? ''}
              </Text>
            ))}
          </View>
        ))}

        {doc.rows.length === 0 && (
          <Text style={{ color: MUTED, marginTop: 10 }}>No records for this selection.</Text>
        )}

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text>{doc.schoolName} - {doc.title}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

export async function renderStaffReportPdfBuffer(doc: StaffReportDoc): Promise<Buffer> {
  return renderToBuffer(<ReportPdf doc={doc} />)
}
