// FILE: app/lib/admitCardPdf.tsx
//
// Server-side (Node) admit card PDF renderer for the exam module.
// Layouts: single (1/A4, full schedule table), two_per_a4 (2/A4,
// compact schedule), three_per_a4 and four_per_a4 (compact cards,
// exam window instead of the full table). Helvetica only, print
// friendly - same conventions as staffReportPdf.tsx.

import React from 'react'
import { Document, Page, Text, View, Image, StyleSheet, renderToBuffer } from '@react-pdf/renderer'

export interface AdmitCardScheduleRow {
  date: string        // pre-formatted, e.g. "10 Sep 2026"
  time: string        // e.g. "10:00 AM"
  subject: string
  room: string        // '' when none
}

export interface AdmitCardData {
  studentName: string
  studentUid: string
  classLabel: string
  rollNumber: number
  seatNumber: string
  photoUrl: string | null
  qrDataUrl: string | null   // pre-rendered QR png data URL
  schedule: AdmitCardScheduleRow[]
}

export interface AdmitCardsDoc {
  schoolName: string
  schoolAddress: string
  logoUrl: string | null
  examName: string
  sessionName: string
  examWindow: string          // "10 Sep - 21 Sep 2026"
  reportingNote: string       // "Report 30 minutes before each paper"
  instructions: string        // general instructions text ('' = none)
  layout: 'single' | 'two_per_a4' | 'three_per_a4' | 'four_per_a4'
  cards: AdmitCardData[]
}

const INK = '#1e293b'
const MUTED = '#64748b'
const BORDER = '#94a3b8'
const LIGHT = '#e2e8f0'

const styles = StyleSheet.create({
  page: { padding: 18, fontFamily: 'Helvetica', color: INK },
  card: {
    borderWidth: 1.2, borderColor: INK, borderRadius: 4,
    padding: 10, marginBottom: 12,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: 1, borderColor: INK, paddingBottom: 6, marginBottom: 6 },
  logo: { width: 30, height: 30 },
  school: { fontFamily: 'Helvetica-Bold' },
  addr: { color: MUTED },
  title: { textAlign: 'center', fontFamily: 'Helvetica-Bold', letterSpacing: 1 },
  sub: { textAlign: 'center', color: MUTED, marginTop: 1 },
  body: { flexDirection: 'row', gap: 10, marginTop: 6 },
  fields: { flex: 1 },
  fRow: { flexDirection: 'row', marginBottom: 3 },
  fLabel: { color: MUTED, width: 62 },
  fValue: { fontFamily: 'Helvetica-Bold', flex: 1 },
  photoBox: {
    width: 62, height: 74, borderWidth: 1, borderColor: BORDER,
    alignItems: 'center', justifyContent: 'center',
  },
  photo: { width: 60, height: 72, objectFit: 'cover' },
  photoNote: { fontSize: 5.5, color: MUTED, textAlign: 'center', padding: 2 },
  qr: { width: 58, height: 58 },
  qrBox: { alignItems: 'center', gap: 2 },
  qrNote: { fontSize: 5.5, color: MUTED },
  tHead: { flexDirection: 'row', backgroundColor: LIGHT, borderWidth: 1, borderColor: BORDER, marginTop: 6 },
  tRow: { flexDirection: 'row', borderLeftWidth: 1, borderRightWidth: 1, borderBottomWidth: 1, borderColor: BORDER },
  tCell: { paddingVertical: 2.5, paddingHorizontal: 4 },
  tBold: { fontFamily: 'Helvetica-Bold' },
  foot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, alignItems: 'flex-end' },
  sig: { borderTopWidth: 1, borderColor: INK, paddingTop: 2, width: 110, textAlign: 'center', color: MUTED },
  instr: { marginTop: 6, color: MUTED },
})

function Card({ doc, card, compact, tiny }: { doc: AdmitCardsDoc; card: AdmitCardData; compact: boolean; tiny: boolean }) {
  const base = tiny ? 6.5 : compact ? 7.5 : 9
  const showSchedule = !tiny
  return (
    <View style={[styles.card, { fontSize: base }]} wrap={false}>
      <View style={styles.head}>
        {doc.logoUrl ? <Image src={doc.logoUrl} style={[styles.logo, tiny ? { width: 20, height: 20 } : {}]} /> : null}
        <View style={{ flex: 1 }}>
          <Text style={[styles.school, { fontSize: base + 3 }]}>{doc.schoolName}</Text>
          {doc.schoolAddress && !tiny ? <Text style={[styles.addr, { fontSize: base - 1.5 }]}>{doc.schoolAddress}</Text> : null}
        </View>
      </View>
      <Text style={[styles.title, { fontSize: base + 1.5 }]}>ADMIT CARD</Text>
      <Text style={[styles.sub, { fontSize: base - 0.5 }]}>{doc.examName} · {doc.sessionName}</Text>

      <View style={styles.body}>
        <View style={styles.fields}>
          <View style={styles.fRow}><Text style={styles.fLabel}>Name</Text><Text style={styles.fValue}>{card.studentName}</Text></View>
          <View style={styles.fRow}><Text style={styles.fLabel}>Student ID</Text><Text style={styles.fValue}>{card.studentUid || '-'}</Text></View>
          <View style={styles.fRow}><Text style={styles.fLabel}>Class</Text><Text style={styles.fValue}>{card.classLabel}</Text></View>
          <View style={styles.fRow}><Text style={styles.fLabel}>Roll No.</Text><Text style={styles.fValue}>{String(card.rollNumber)}</Text></View>
          {card.seatNumber ? (
            <View style={styles.fRow}><Text style={styles.fLabel}>Seat</Text><Text style={styles.fValue}>{card.seatNumber}</Text></View>
          ) : null}
          <View style={styles.fRow}><Text style={styles.fLabel}>Exam dates</Text><Text style={styles.fValue}>{doc.examWindow}</Text></View>
        </View>
        <View style={styles.photoBox}>
          {card.photoUrl
            ? <Image src={card.photoUrl} style={styles.photo} />
            : <Text style={styles.photoNote}>Affix{'\n'}photo</Text>}
        </View>
        {card.qrDataUrl ? (
          <View style={styles.qrBox}>
            <Image src={card.qrDataUrl} style={[styles.qr, tiny ? { width: 44, height: 44 } : {}]} />
            <Text style={styles.qrNote}>Scan to verify</Text>
          </View>
        ) : null}
      </View>

      {showSchedule && card.schedule.length > 0 ? (
        <>
          <View style={styles.tHead}>
            <Text style={[styles.tCell, styles.tBold, { width: '26%' }]}>Date</Text>
            <Text style={[styles.tCell, styles.tBold, { width: '20%' }]}>Time</Text>
            <Text style={[styles.tCell, styles.tBold, { width: '34%' }]}>Subject</Text>
            <Text style={[styles.tCell, styles.tBold, { width: '20%' }]}>Room</Text>
          </View>
          {card.schedule.map((r, i) => (
            <View key={i} style={styles.tRow}>
              <Text style={[styles.tCell, { width: '26%' }]}>{r.date}</Text>
              <Text style={[styles.tCell, { width: '20%' }]}>{r.time}</Text>
              <Text style={[styles.tCell, { width: '34%' }]}>{r.subject}</Text>
              <Text style={[styles.tCell, { width: '20%' }]}>{r.room || '-'}</Text>
            </View>
          ))}
        </>
      ) : null}

      {!tiny && doc.instructions ? (
        <Text style={[styles.instr, { fontSize: base - 1.5 }]}>{doc.instructions}</Text>
      ) : null}
      {!tiny ? <Text style={[styles.instr, { fontSize: base - 1.5 }]}>{doc.reportingNote}</Text> : null}

      <View style={styles.foot}>
        <Text style={{ fontSize: base - 2, color: MUTED }}>Carry this card to every paper.</Text>
        <Text style={[styles.sig, { fontSize: base - 1.5 }]}>Principal&apos;s Signature</Text>
      </View>
    </View>
  )
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const PER_PAGE: Record<AdmitCardsDoc['layout'], number> = {
  single: 1, two_per_a4: 2, three_per_a4: 3, four_per_a4: 4,
}

function AdmitCardsPdf({ doc }: { doc: AdmitCardsDoc }) {
  const per = PER_PAGE[doc.layout]
  const compact = per >= 2
  const tiny = per >= 3
  return (
    <Document>
      {chunk(doc.cards, per).map((group, pi) => (
        <Page key={pi} size="A4" style={styles.page}>
          {group.map((card, ci) => (
            <Card key={ci} doc={doc} card={card} compact={compact} tiny={tiny} />
          ))}
        </Page>
      ))}
    </Document>
  )
}

export async function renderAdmitCardsPdfBuffer(doc: AdmitCardsDoc): Promise<Buffer> {
  return renderToBuffer(<AdmitCardsPdf doc={doc} />)
}
