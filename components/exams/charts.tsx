'use client'

// FILE: components/exams/charts.tsx
// Exam analytics charts (recharts). Palette validated with the dataviz
// skill's validator (passes light + dark, CVD-safe):
//   #2563eb blue · #d97706 amber · #0d9488 teal · #7c3aed violet
// Rules applied: one y-axis only; single series => no legend; >=2 series
// => legend + a table view is available on the page; thin marks; 4px
// rounded bar ends; recessive grid.

import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell, LabelList,
} from 'recharts'

export const CAT = ['#2563eb', '#d97706', '#0d9488', '#7c3aed'] as const
const GRID = '#e2e8f0'
const AXIS = '#94a3b8'
const INK = '#334155'

const axisProps = {
  tick: { fontSize: 11, fill: AXIS },
  stroke: GRID,
  tickLine: false,
}

function ChartTip({ active, payload, label, suffix }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-sm px-3 py-2 text-xs">
      <p className="font-medium text-slate-700 mb-1">{label}</p>
      {payload.map((p: any, i: number) => (
        <p key={i} className="text-slate-600 flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm" style={{ background: p.color || p.fill }} />
          {p.name}: <span className="font-semibold">{p.value}{suffix ?? ''}</span>
        </p>
      ))}
    </div>
  )
}

// ── Grade distribution (single series, magnitude) ──────────────
export function GradeDistributionChart({ data }: { data: Array<{ grade_label: string; student_count: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 16, right: 8, bottom: 4, left: -16 }}>
        <CartesianGrid vertical={false} stroke={GRID} strokeDasharray="2 4" />
        <XAxis dataKey="grade_label" {...axisProps} />
        <YAxis allowDecimals={false} {...axisProps} />
        <Tooltip content={<ChartTip suffix=" students" />} cursor={{ fill: '#f1f5f9' }} />
        <Bar dataKey="student_count" name="Students" fill={CAT[0]} radius={[4, 4, 0, 0]} maxBarSize={48}>
          <LabelList dataKey="student_count" position="top" style={{ fontSize: 11, fill: INK }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Subject performance (2 series: avg %, pass %) ──────────────
export function SubjectPerformanceChart({ data }: { data: Array<{ subject_name: string; average_pct: number; pass_pct: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 16, right: 8, bottom: 4, left: -16 }}>
        <CartesianGrid vertical={false} stroke={GRID} strokeDasharray="2 4" />
        <XAxis dataKey="subject_name" {...axisProps} interval={0} angle={data.length > 5 ? -20 : 0} textAnchor={data.length > 5 ? 'end' : 'middle'} height={data.length > 5 ? 50 : 30} />
        <YAxis domain={[0, 100]} {...axisProps} />
        <Tooltip content={<ChartTip suffix="%" />} cursor={{ fill: '#f1f5f9' }} />
        <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={8} />
        <Bar dataKey="average_pct" name="Average %" fill={CAT[0]} radius={[4, 4, 0, 0]} maxBarSize={28} />
        <Bar dataKey="pass_pct" name="Pass %" fill={CAT[2]} radius={[4, 4, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Class comparison (single series, avg % per class) ──────────
export function ClassComparisonChart({ data }: { data: Array<{ class_label: string; average_pct: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 16, right: 8, bottom: 4, left: -16 }}>
        <CartesianGrid vertical={false} stroke={GRID} strokeDasharray="2 4" />
        <XAxis dataKey="class_label" {...axisProps} />
        <YAxis domain={[0, 100]} {...axisProps} />
        <Tooltip content={<ChartTip suffix="%" />} cursor={{ fill: '#f1f5f9' }} />
        <Bar dataKey="average_pct" name="Average %" fill={CAT[0]} radius={[4, 4, 0, 0]} maxBarSize={44}>
          <LabelList dataKey="average_pct" position="top" style={{ fontSize: 10, fill: INK }} formatter={(v: number) => `${v}%`} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── School performance over exams (2 lines: avg %, pass %) ─────
export function SchoolTrendChart({ data }: { data: Array<{ exam_name: string; average_pct: number; pass_pct: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 16, right: 12, bottom: 4, left: -16 }}>
        <CartesianGrid vertical={false} stroke={GRID} strokeDasharray="2 4" />
        <XAxis dataKey="exam_name" {...axisProps} interval={0} angle={data.length > 4 ? -20 : 0} textAnchor={data.length > 4 ? 'end' : 'middle'} height={data.length > 4 ? 50 : 30} />
        <YAxis domain={[0, 100]} {...axisProps} />
        <Tooltip content={<ChartTip suffix="%" />} />
        <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={8} />
        <Line dataKey="average_pct" name="Average %" stroke={CAT[0]} strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }} />
        <Line dataKey="pass_pct" name="Pass %" stroke={CAT[2]} strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }} />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ── Student progress over exams (single line, %) ───────────────
export function StudentProgressChart({ data }: { data: Array<{ exam_name: string; percentage: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 16, right: 12, bottom: 4, left: -16 }}>
        <CartesianGrid vertical={false} stroke={GRID} strokeDasharray="2 4" />
        <XAxis dataKey="exam_name" {...axisProps} />
        <YAxis domain={[0, 100]} {...axisProps} />
        <Tooltip content={<ChartTip suffix="%" />} />
        <Line dataKey="percentage" name="Percentage" stroke={CAT[0]} strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }}>
          <LabelList dataKey="percentage" position="top" style={{ fontSize: 10, fill: INK }} formatter={(v: number) => `${v}%`} />
        </Line>
      </LineChart>
    </ResponsiveContainer>
  )
}
