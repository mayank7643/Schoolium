'use client'

import { useState, useCallback } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, IndianRupee, AlertCircle, CheckCircle2,
  Clock, Download, Loader2
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────
interface ClassOption { id: string; name: string; section: string | null }
interface FeeRow {
  id: string
  amount: number
  status: string
  fee_type: string
  due_date: string | null
  paid_date: string | null
  created_at: string
  student_id: string
  students: {
    id: string
    full_name: string
    student_uid: string | null
    father_name: string | null
    class_id: string | null
  } | null
}
interface StudentRow { id: string; class_id: string | null }

interface ClassSummary {
  classId: string
  className: string
  totalStudents: number
  collected: number
  pending: number
  overdue: number
  rows: {
    studentId: string
    full_name: string
    student_uid: string | null
    father_name: string | null
    fee_type: string
    amount: number
    status: string
    date: string | null
  }[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sortClassLabel(a: ClassSummary, b: ClassSummary): number {
  const aNum = parseInt(a.className), bNum = parseInt(b.className)
  const aIsNum = !isNaN(aNum), bIsNum = !isNaN(bNum)
  if (aIsNum && bIsNum) return aNum - bNum
  if (aIsNum) return -1
  if (bIsNum) return 1
  return a.className.localeCompare(b.className)
}

function fmtDate(d: string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function fmtINR(n: number): string {
  return '₹' + n.toLocaleString('en-IN')
}

function buildSummaries(
  classes: ClassOption[],
  fees: FeeRow[],
  students: StudentRow[]
): ClassSummary[] {
  const studentCountByClass: Record<string, number> = {}
  students.forEach(s => {
    if (s.class_id) studentCountByClass[s.class_id] = (studentCountByClass[s.class_id] ?? 0) + 1
  })

  const map: Record<string, ClassSummary> = {}
  classes.forEach(cls => {
    map[cls.id] = {
      classId: cls.id,
      className: `${cls.name}${cls.section ? ` — ${cls.section}` : ''}`,
      totalStudents: studentCountByClass[cls.id] ?? 0,
      collected: 0, pending: 0, overdue: 0,
      rows: [],
    }
  })

  fees.forEach(fee => {
    const student = fee.students
    if (!student?.class_id || !map[student.class_id]) return
    const summary = map[student.class_id]
    const amount = Number(fee.amount)
    const date = fee.status === 'paid' ? fee.paid_date : fee.due_date

    if (fee.status === 'paid')         summary.collected += amount
    else if (fee.status === 'overdue') summary.overdue   += amount
    else                               summary.pending    += amount

    summary.rows.push({
      studentId: student.id,
      full_name: student.full_name,
      student_uid: student.student_uid,
      father_name: student.father_name,
      fee_type: fee.fee_type,
      amount,
      status: fee.status,
      date,
    })
  })

  return Object.values(map)
    .filter(s => s.collected > 0 || s.pending > 0 || s.overdue > 0 || s.totalStudents > 0)
    .sort(sortClassLabel)
}

// ── PDF generation — runs entirely in browser, no server cost ─────────────────
async function downloadPdf(
  schoolName: string,
  summary: ClassSummary,
  allClasses: boolean
) {
  // Dynamic import — keeps the PDF library out of initial JS bundle
  const { pdf, Document, Page, Text, View, StyleSheet } = await import('@react-pdf/renderer')

  const styles = StyleSheet.create({
    page: { padding: 36, fontFamily: 'Helvetica', fontSize: 9, color: '#1e293b' },
    header: { marginBottom: 16 },
    schoolName: { fontSize: 16, fontFamily: 'Helvetica-Bold', color: '#1d4ed8', marginBottom: 2 },
    subtitle: { fontSize: 9, color: '#64748b', marginBottom: 2 },
    divider: { borderBottomWidth: 1, borderBottomColor: '#e2e8f0', marginBottom: 12 },
    statRow: { flexDirection: 'row', gap: 12, marginBottom: 14 },
    statBox: { flex: 1, backgroundColor: '#f8fafc', borderRadius: 4, padding: 8, borderWidth: 1, borderColor: '#e2e8f0' },
    statLabel: { fontSize: 7, color: '#94a3b8', marginBottom: 2, textTransform: 'uppercase' },
    statValue: { fontSize: 12, fontFamily: 'Helvetica-Bold' },
    tableHeader: {
      flexDirection: 'row', backgroundColor: '#f1f5f9',
      borderTopLeftRadius: 4, borderTopRightRadius: 4,
      borderWidth: 1, borderColor: '#e2e8f0',
      paddingVertical: 5, paddingHorizontal: 6,
    },
    tableRow: {
      flexDirection: 'row',
      borderLeftWidth: 1, borderRightWidth: 1, borderBottomWidth: 1,
      borderColor: '#e2e8f0',
      paddingVertical: 4, paddingHorizontal: 6,
    },
    tableRowAlt: { backgroundColor: '#f8fafc' },
    thText: { fontSize: 7, fontFamily: 'Helvetica-Bold', color: '#64748b', textTransform: 'uppercase' },
    tdText: { fontSize: 8, color: '#334155' },
    col1: { width: '5%' },
    col2: { width: '22%' },
    col3: { width: '15%' },
    col4: { width: '18%' },
    col5: { width: '12%' },
    col6: { width: '12%' },
    col7: { width: '16%' },
    statusPaid:    { color: '#16a34a', fontFamily: 'Helvetica-Bold' },
    statusPending: { color: '#ca8a04', fontFamily: 'Helvetica-Bold' },
    statusOverdue: { color: '#dc2626', fontFamily: 'Helvetica-Bold' },
    classTitle: { fontSize: 11, fontFamily: 'Helvetica-Bold', marginBottom: 6, marginTop: 12, color: '#1e293b' },
    footer: { position: 'absolute', bottom: 24, left: 36, right: 36, flexDirection: 'row', justifyContent: 'space-between' },
    footerText: { fontSize: 7, color: '#94a3b8' },
    pageNum: { fontSize: 7, color: '#94a3b8' },
  })

  const generatedAt = new Date().toLocaleDateString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
  })

  // Which summaries to render
  const toRender = allClasses
    ? (window as any).__schooliumSummaries as ClassSummary[]
    : [summary]

  const grandCollected = toRender.reduce((s, c) => s + c.collected, 0)
  const grandPending   = toRender.reduce((s, c) => s + c.pending, 0)
  const grandOverdue   = toRender.reduce((s, c) => s + c.overdue, 0)

  const TableRow = ({ row, idx }: { row: ClassSummary['rows'][0]; idx: number }) => {
    const statusStyle = row.status === 'paid' ? styles.statusPaid
      : row.status === 'overdue' ? styles.statusOverdue : styles.statusPending
    return (
      <View style={[styles.tableRow, idx % 2 === 1 ? styles.tableRowAlt : {}]}>
        <Text style={[styles.tdText, styles.col1]}>{idx + 1}</Text>
        <Text style={[styles.tdText, styles.col2]}>{row.full_name}</Text>
        <Text style={[styles.tdText, styles.col3]}>{row.student_uid ?? '—'}</Text>
        <Text style={[styles.tdText, styles.col4]}>{row.father_name ?? '—'}</Text>
        <Text style={[styles.tdText, styles.col5, { textTransform: 'capitalize' }]}>{row.fee_type}</Text>
        <Text style={[styles.tdText, styles.col6]}>{fmtINR(row.amount)}</Text>
        <Text style={[statusStyle, styles.col7, { fontSize: 8 }]}>
          {row.status.toUpperCase()}
          {row.date ? `\n${fmtDate(row.date)}` : ''}
        </Text>
      </View>
    )
  }

  const MyDoc = (
    <Document title={`Fee Report — ${schoolName}`} author="Schoolium">
      <Page size="A4" orientation="landscape" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.schoolName}>{schoolName}</Text>
          <Text style={styles.subtitle}>
            Fee Report — {allClasses ? 'All Classes' : toRender[0].className}
          </Text>
          <Text style={styles.subtitle}>Generated: {generatedAt}</Text>
        </View>
        <View style={styles.divider} />

        {/* Grand totals */}
        <View style={styles.statRow}>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Total Collected</Text>
            <Text style={[styles.statValue, { color: '#16a34a' }]}>{fmtINR(grandCollected)}</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Total Pending</Text>
            <Text style={[styles.statValue, { color: '#ca8a04' }]}>{fmtINR(grandPending)}</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Total Overdue</Text>
            <Text style={[styles.statValue, { color: '#dc2626' }]}>{fmtINR(grandOverdue)}</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Total Records</Text>
            <Text style={[styles.statValue, { color: '#1d4ed8' }]}>
              {toRender.reduce((s, c) => s + c.rows.length, 0)}
            </Text>
          </View>
        </View>

        {/* Per-class tables */}
        {toRender.map(cls => (
          <View key={cls.classId}>
            <Text style={styles.classTitle}>
              {cls.className} · {cls.totalStudents} students · Collected {fmtINR(cls.collected)} · Pending {fmtINR(cls.pending)} · Overdue {fmtINR(cls.overdue)}
            </Text>
            {/* Table header */}
            <View style={styles.tableHeader}>
              <Text style={[styles.thText, styles.col1]}>#</Text>
              <Text style={[styles.thText, styles.col2]}>Name</Text>
              <Text style={[styles.thText, styles.col3]}>Student ID</Text>
              <Text style={[styles.thText, styles.col4]}>Father</Text>
              <Text style={[styles.thText, styles.col5]}>Type</Text>
              <Text style={[styles.thText, styles.col6]}>Amount</Text>
              <Text style={[styles.thText, styles.col7]}>Status / Date</Text>
            </View>
            {/* Table rows */}
            {cls.rows.length > 0
              ? cls.rows.map((row, i) => <TableRow key={row.studentId + i} row={row} idx={i} />)
              : (
                <View style={[styles.tableRow]}>
                  <Text style={[styles.tdText, { color: '#94a3b8' }]}>No fee records for this class</Text>
                </View>
              )
            }
          </View>
        ))}

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>Schoolium · {schoolName}</Text>
          <Text style={styles.pageNum} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )

  const blob = await pdf(MyDoc).toBlob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const label = allClasses ? 'All-Classes' : summary.className.replace(/\s/g, '-').replace(/[—/]/g, '')
  a.download = `Fee-Report-${label}-${new Date().toISOString().split('T')[0]}.pdf`
  a.click()
  URL.revokeObjectURL(url)
}

// ── Main client component ─────────────────────────────────────────────────────
export default function FeeSummaryClient({
  schoolName,
  classes,
  fees,
  students,
}: {
  schoolName: string
  classes: ClassOption[]
  fees: FeeRow[]
  students: StudentRow[]
}) {
  const [classFilter, setClassFilter] = useState('') // '' = all
  const [pdfLoading, setPdfLoading] = useState<string | null>(null) // classId or 'all'

  const allSummaries = buildSummaries(classes, fees, students)

  // Expose summaries to PDF generator (avoids re-computing inside async fn)
  if (typeof window !== 'undefined') {
    ;(window as any).__schooliumSummaries = allSummaries
  }

  const displayedSummaries = classFilter
    ? allSummaries.filter(s => s.classId === classFilter)
    : allSummaries

  const grandCollected  = displayedSummaries.reduce((s, c) => s + c.collected, 0)
  const grandPending    = displayedSummaries.reduce((s, c) => s + c.pending, 0)
  const grandOverdue    = displayedSummaries.reduce((s, c) => s + c.overdue, 0)
  const totalDefaulters = displayedSummaries.reduce((s, c) => s + c.rows.filter(r => r.status === 'overdue').length, 0)

  const handlePdf = useCallback(async (summary: ClassSummary, isAll: boolean) => {
    const key = isAll ? 'all' : summary.classId
    setPdfLoading(key)
    try {
      await downloadPdf(schoolName, summary, isAll)
    } finally {
      setPdfLoading(null)
    }
  }, [schoolName])

  const selectedSummary = classFilter ? allSummaries.find(s => s.classId === classFilter) : null

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/fees"
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors"
          >
            <ArrowLeft size={18} className="text-slate-600" />
          </Link>
          <div>
            <h1 className="text-xl lg:text-2xl font-bold text-slate-900">Fee summary by class</h1>
            <p className="text-slate-500 text-sm mt-0.5">Collected, pending and overdue across all classes</p>
          </div>
        </div>
        {/* Download all button */}
        <button
          onClick={() => handlePdf(allSummaries[0], true)}
          disabled={pdfLoading === 'all' || allSummaries.length === 0}
          className="btn-secondary flex items-center gap-2 text-sm"
        >
          {pdfLoading === 'all'
            ? <><Loader2 size={14} className="animate-spin" />Generating...</>
            : <><Download size={14} />Download all</>}
        </button>
      </div>

      {/* Class filter pills */}
      <div className="flex gap-2 flex-wrap mb-5">
        <button
          onClick={() => setClassFilter('')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            !classFilter ? 'bg-brand-600 text-white border-brand-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >All classes</button>
        {allSummaries.map(s => (
          <button
            key={s.classId}
            onClick={() => setClassFilter(s.classId)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              classFilter === s.classId ? 'bg-brand-600 text-white border-brand-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
          >{s.className}</button>
        ))}
      </div>

      {/* Grand totals for current view */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <div className="stat-card">
          <div className="w-8 h-8 bg-green-50 rounded-lg flex items-center justify-center mb-2">
            <CheckCircle2 size={16} className="text-green-600" />
          </div>
          <p className="text-xl font-bold text-green-600">{fmtINR(grandCollected)}</p>
          <p className="text-xs text-slate-500">Total collected</p>
        </div>
        <div className="stat-card">
          <div className="w-8 h-8 bg-yellow-50 rounded-lg flex items-center justify-center mb-2">
            <Clock size={16} className="text-yellow-600" />
          </div>
          <p className="text-xl font-bold text-yellow-600">{fmtINR(grandPending)}</p>
          <p className="text-xs text-slate-500">Total pending</p>
        </div>
        <div className="stat-card">
          <div className="w-8 h-8 bg-red-50 rounded-lg flex items-center justify-center mb-2">
            <AlertCircle size={16} className="text-red-600" />
          </div>
          <p className="text-xl font-bold text-red-600">{fmtINR(grandOverdue)}</p>
          <p className="text-xs text-slate-500">Total overdue</p>
        </div>
        <div className="stat-card">
          <div className="w-8 h-8 bg-orange-50 rounded-lg flex items-center justify-center mb-2">
            <IndianRupee size={16} className="text-orange-600" />
          </div>
          <p className="text-xl font-bold text-orange-600">{totalDefaulters}</p>
          <p className="text-xs text-slate-500">Defaulters</p>
        </div>
      </div>

      {/* Class cards */}
      {displayedSummaries.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <IndianRupee size={24} className="text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-900 mb-1">No fee records yet</h3>
          <p className="text-sm text-slate-500 mb-4">Record payments to see the class-wise breakdown here</p>
          <Link href="/dashboard/fees" className="btn-primary text-sm">Go to Fees</Link>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {displayedSummaries.map(cls => {
            const total = cls.collected + cls.pending + cls.overdue
            const collectedPct = total > 0 ? Math.round((cls.collected / total) * 100) : 0
            const pendingPct   = total > 0 ? Math.round((cls.pending / total) * 100) : 0
            const overduePct   = total > 0 ? Math.round((cls.overdue / total) * 100) : 0
            const isPdfLoading = pdfLoading === cls.classId

            return (
              <div key={cls.classId} className="card p-0 overflow-hidden">
                {/* Class header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
                  <div className="flex items-center gap-3">
                    <div className="w-1 h-5 bg-brand-600 rounded-full" />
                    <div>
                      <p className="font-semibold text-slate-900">{cls.className}</p>
                      <p className="text-xs text-slate-400">{cls.totalStudents} student{cls.totalStudents !== 1 ? 's' : ''} · {cls.rows.length} fee record{cls.rows.length !== 1 ? 's' : ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                      collectedPct >= 80 ? 'bg-green-50 text-green-700' :
                      collectedPct >= 50 ? 'bg-yellow-50 text-yellow-700' :
                      'bg-red-50 text-red-700'
                    }`}>
                      {collectedPct}% collected
                    </span>
                    {/* Per-class PDF button */}
                    <button
                      onClick={() => handlePdf(cls, false)}
                      disabled={isPdfLoading}
                      className="flex items-center gap-1.5 text-xs text-brand-600 border border-brand-200 px-2.5 py-1 rounded-lg hover:bg-brand-50 transition-colors disabled:opacity-50"
                    >
                      {isPdfLoading
                        ? <Loader2 size={11} className="animate-spin" />
                        : <Download size={11} />}
                      PDF
                    </button>
                  </div>
                </div>

                {/* Totals row */}
                <div className="grid grid-cols-3 divide-x divide-slate-100">
                  <div className="px-5 py-3">
                    <p className="text-xs text-slate-400 mb-0.5">Collected</p>
                    <p className="font-semibold text-green-600">{fmtINR(cls.collected)}</p>
                  </div>
                  <div className="px-5 py-3">
                    <p className="text-xs text-slate-400 mb-0.5">Pending</p>
                    <p className="font-semibold text-yellow-600">{fmtINR(cls.pending)}</p>
                  </div>
                  <div className="px-5 py-3">
                    <p className="text-xs text-slate-400 mb-0.5">Overdue</p>
                    <p className="font-semibold text-red-600">{fmtINR(cls.overdue)}</p>
                  </div>
                </div>

                {/* Progress bar */}
                {total > 0 && (
                  <div className="px-5 pb-3">
                    <div className="w-full h-1.5 rounded-full overflow-hidden bg-slate-100 flex">
                      {collectedPct > 0 && <div className="bg-green-400 h-full" style={{ width: `${collectedPct}%` }} />}
                      {pendingPct   > 0 && <div className="bg-yellow-400 h-full" style={{ width: `${pendingPct}%` }} />}
                      {overduePct   > 0 && <div className="bg-red-400 h-full" style={{ width: `${overduePct}%` }} />}
                    </div>
                  </div>
                )}

                {/* Detailed fee rows table */}
                {cls.rows.length > 0 && (
                  <div className="border-t border-slate-100 overflow-x-auto">
                    <table className="table" style={{ tableLayout: 'fixed', width: '100%', minWidth: 560 }}>
                      <colgroup>
                        <col style={{ width: '22%' }} />
                        <col style={{ width: '13%' }} />
                        <col style={{ width: '20%' }} />
                        <col style={{ width: '12%' }} />
                        <col style={{ width: '11%' }} />
                        <col style={{ width: '22%' }} />
                      </colgroup>
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Student ID</th>
                          <th>Father</th>
                          <th>Type</th>
                          <th>Amount</th>
                          <th>Status / Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cls.rows.map((row, i) => (
                          <tr key={row.studentId + i}>
                            <td>
                              <Link
                                href={`/dashboard/students/${row.studentId}`}
                                className="font-medium text-slate-800 hover:text-brand-600 hover:underline text-sm"
                              >
                                {row.full_name}
                              </Link>
                            </td>
                            <td>
                              {row.student_uid
                                ? <span className="font-mono text-xs bg-brand-50 text-brand-700 border border-brand-200 px-1.5 py-0.5 rounded">{row.student_uid}</span>
                                : <span className="text-slate-300">—</span>}
                            </td>
                            <td className="text-slate-600 text-sm truncate">{row.father_name ?? <span className="text-slate-300">—</span>}</td>
                            <td>
                              <span className="capitalize text-slate-600 text-sm">{row.fee_type}</span>
                            </td>
                            <td className="font-medium text-slate-800 text-sm">{fmtINR(row.amount)}</td>
                            <td>
                              <div className="flex flex-col gap-0.5">
                                <span className={`text-xs font-medium capitalize ${
                                  row.status === 'paid' ? 'text-green-600' :
                                  row.status === 'overdue' ? 'text-red-600' : 'text-yellow-600'
                                }`}>
                                  {row.status}
                                </span>
                                {row.date && (
                                  <span className="text-[10px] text-slate-400">{fmtDate(row.date)}</span>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
