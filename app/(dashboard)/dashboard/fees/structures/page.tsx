'use client'

// FILE: app/(dashboard)/dashboard/fees/structures/page.tsx
//
// Fee Structures page — admin creates fee templates per class.
// Each structure defines what fees a class pays, how often, and how much.
// Once saved, admin clicks "Generate Dues" to auto-create monthly dues for all students.
//
// IMPORTANT: This page does NOT touch the existing 'fees' table.
// Manual billing (fees page) stays completely separate and intact.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import {
  Plus, X, ChevronDown, ChevronUp, Trash2,
  Zap, CheckCircle2, AlertCircle, Settings,
  GraduationCap, IndianRupee, Clock, ToggleLeft, ToggleRight,
  RefreshCw, ListChecks,
} from 'lucide-react'
import type {
  FeeStructure, FeeStructureItem, FeeModuleType,
  FeeFrequency, LateFeeType,
} from '@/types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClassOption {
  id: string
  name: string
  section: string | null
}

interface StructureWithItems extends Omit<FeeStructure, 'classes' | 'items'> {
  items: FeeStructureItem[]
  classes: { name: string; section: string | null } | null
}

interface ItemForm {
  id?: string                      // present when editing existing item
  fee_type: FeeModuleType
  label: string
  amount: string
  frequency: FeeFrequency
  applicable_months: string[]      // for 'custom'
  quarterly_months: string[]       // for 'quarterly' — stored as strings in form
  is_enabled: boolean
}

interface StructureForm {
  name: string
  class_id: string
  academic_year: string
  year_start_month: string
  year_end_month: string
  due_day_of_month: string
  late_fee_enabled: boolean
  late_fee_type: LateFeeType
  late_fee_value: string
  late_fee_grace_days: string
  items: ItemForm[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FEE_TYPE_OPTIONS: { value: FeeModuleType; label: string }[] = [
  { value: 'tuition',   label: 'Tuition Fee' },
  { value: 'admission', label: 'Admission Fee' },
  { value: 'exam',      label: 'Examination Fee' },
  { value: 'transport', label: 'Transport Fee' },
  { value: 'hostel',    label: 'Hostel Fee' },
  { value: 'custom',    label: 'Custom / Other' },
]

const FREQUENCY_OPTIONS: { value: FeeFrequency; label: string; desc: string }[] = [
  { value: 'monthly',   label: 'Monthly',   desc: 'Every month of the academic year' },
  { value: 'one_time',  label: 'One Time',  desc: 'Only in the first month' },
  { value: 'quarterly', label: 'Quarterly', desc: 'Once every 3 months (you pick which months)' },
  { value: 'custom',    label: 'Custom',    desc: 'You pick exactly which months' },
]

const MONTH_OPTIONS = [
  { value: '1',  label: 'January' },
  { value: '2',  label: 'February' },
  { value: '3',  label: 'March' },
  { value: '4',  label: 'April' },
  { value: '5',  label: 'May' },
  { value: '6',  label: 'June' },
  { value: '7',  label: 'July' },
  { value: '8',  label: 'August' },
  { value: '9',  label: 'September' },
  { value: '10', label: 'October' },
  { value: '11', label: 'November' },
  { value: '12', label: 'December' },
]

const CURRENT_YEAR = new Date().getFullYear()
const ACADEMIC_YEAR_OPTIONS = [
  `${CURRENT_YEAR - 1}-${String(CURRENT_YEAR).slice(2)}`,
  `${CURRENT_YEAR}-${String(CURRENT_YEAR + 1).slice(2)}`,
  `${CURRENT_YEAR + 1}-${String(CURRENT_YEAR + 2).slice(2)}`,
]

const BLANK_ITEM: ItemForm = {
  fee_type:          'tuition',
  label:             'Tuition Fee',
  amount:            '',
  frequency:         'monthly',
  applicable_months: [],
  quarterly_months:  ['4', '7', '10', '1'],
  is_enabled:        true,
}

const BLANK_FORM: StructureForm = {
  name:               '',
  class_id:           '',
  academic_year:      ACADEMIC_YEAR_OPTIONS[1],
  year_start_month:   '4',
  year_end_month:     '3',
  due_day_of_month:   '10',
  late_fee_enabled:   false,
  late_fee_type:      'fixed',
  late_fee_value:     '',
  late_fee_grace_days:'10',
  items:              [{ ...BLANK_ITEM }],
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCurrency(n: number): string {
  return '₹' + n.toLocaleString('en-IN')
}

function getMonthName(num: string): string {
  return MONTH_OPTIONS.find(m => m.value === num)?.label ?? num
}

function buildYearMonths(
  academic_year: string,
  year_start_month: number,
): { label: string; value: string }[] {
  const startYear = parseInt(academic_year.split('-')[0])
  const months: { label: string; value: string }[] = []
  for (let i = 0; i < 12; i++) {
    const absMonth = year_start_month + i
    const y  = startYear + Math.floor((absMonth - 1) / 12)
    const mo = ((absMonth - 1) % 12) + 1
    const value = `${y}-${String(mo).padStart(2, '0')}`
    const label = new Date(y, mo - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
    months.push({ label, value })
  }
  return months
}

// ── ItemForm Component ────────────────────────────────────────────────────────

function FeeItemRow({
  item,
  index,
  academicYear,
  yearStartMonth,
  onChange,
  onRemove,
  canRemove,
}: {
  item: ItemForm
  index: number
  academicYear: string
  yearStartMonth: string
  onChange: (index: number, updated: ItemForm) => void
  onRemove: (index: number) => void
  canRemove: boolean
}) {
  const [expanded, setExpanded] = useState(true)

  const yearMonths = buildYearMonths(academicYear, parseInt(yearStartMonth))

  function set(field: keyof ItemForm, value: ItemForm[keyof ItemForm]) {
    onChange(index, { ...item, [field]: value })
  }

  function toggleCustomMonth(val: string) {
    const current = item.applicable_months
    if (current.includes(val)) {
      set('applicable_months', current.filter(m => m !== val))
    } else {
      set('applicable_months', [...current, val].sort())
    }
  }

  function toggleQuarterlyMonth(val: string) {
    const current = item.quarterly_months
    if (current.includes(val)) {
      set('quarterly_months', current.filter(m => m !== val))
    } else {
      set('quarterly_months', [...current, val])
    }
  }

  return (
    <div className={`border rounded-xl transition-colors ${item.is_enabled ? 'border-slate-200 bg-white' : 'border-slate-100 bg-slate-50'}`}>
      {/* Row header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => set('is_enabled', !item.is_enabled)}
          className="shrink-0 text-slate-400 hover:text-brand-600 transition-colors"
          title={item.is_enabled ? 'Disable this fee' : 'Enable this fee'}
        >
          {item.is_enabled
            ? <ToggleRight size={22} className="text-brand-600" />
            : <ToggleLeft size={22} />}
        </button>

        <div className="flex-1 min-w-0">
          <p className={`font-medium text-sm ${item.is_enabled ? 'text-slate-900' : 'text-slate-400'}`}>
            {item.label || `Fee item ${index + 1}`}
          </p>
          <p className="text-xs text-slate-400 mt-0.5">
            {item.amount ? formatCurrency(parseFloat(item.amount) || 0) : '₹0'} ·{' '}
            {FREQUENCY_OPTIONS.find(f => f.value === item.frequency)?.label}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-400"
          >
            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
          {canRemove && (
            <button
              type="button"
              onClick={() => onRemove(index)}
              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-50 text-slate-300 hover:text-red-500 transition-colors"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Expanded fields */}
      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-3 border-t border-slate-100 pt-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Fee type *</label>
              <select
                className="input"
                value={item.fee_type}
                onChange={e => {
                  const ft = e.target.value as FeeModuleType
                  const defaultLabel = FEE_TYPE_OPTIONS.find(o => o.value === ft)?.label ?? ''
                  set('fee_type', ft)
                  if (!item.label || FEE_TYPE_OPTIONS.some(o => o.label === item.label)) {
                    onChange(index, { ...item, fee_type: ft, label: defaultLabel })
                  }
                }}
              >
                {FEE_TYPE_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Label (shown on receipt) *</label>
              <input
                type="text"
                className="input"
                placeholder="e.g. Tuition Fee"
                value={item.label}
                onChange={e => set('label', e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Amount (₹) *</label>
              <input
                type="text"
                inputMode="numeric"
                className="input"
                placeholder="2500"
                value={item.amount}
                onChange={e => {
                  if (e.target.value === '' || /^\d+(\.\d{0,2})?$/.test(e.target.value)) {
                    set('amount', e.target.value)
                  }
                }}
              />
            </div>
            <div>
              <label className="label">Frequency *</label>
              <select
                className="input"
                value={item.frequency}
                onChange={e => set('frequency', e.target.value as FeeFrequency)}
              >
                {FREQUENCY_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p className="text-[11px] text-slate-400 mt-1">
                {FREQUENCY_OPTIONS.find(f => f.value === item.frequency)?.desc}
              </p>
            </div>
          </div>

          {/* Quarterly month picker */}
          {item.frequency === 'quarterly' && (
            <div>
              <label className="label">Which months? (pick 3-4)</label>
              <div className="grid grid-cols-4 gap-1.5">
                {MONTH_OPTIONS.map(m => {
                  const selected = item.quarterly_months.includes(m.value)
                  return (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => toggleQuarterlyMonth(m.value)}
                      className={`py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        selected
                          ? 'bg-brand-600 text-white border-brand-600'
                          : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {m.label.slice(0, 3)}
                    </button>
                  )
                })}
              </div>
              {item.quarterly_months.length > 0 && (
                <p className="text-xs text-slate-500 mt-1">
                  Selected: {item.quarterly_months.map(getMonthName).join(', ')}
                </p>
              )}
            </div>
          )}

          {/* Custom month picker */}
          {item.frequency === 'custom' && (
            <div>
              <label className="label">Which months of this academic year?</label>
              <div className="grid grid-cols-4 gap-1.5">
                {yearMonths.map(m => {
                  const selected = item.applicable_months.includes(m.value)
                  return (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => toggleCustomMonth(m.value)}
                      className={`py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        selected
                          ? 'bg-brand-600 text-white border-brand-600'
                          : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {m.label}
                    </button>
                  )
                })}
              </div>
              {item.applicable_months.length > 0 && (
                <p className="text-xs text-slate-500 mt-1">
                  {item.applicable_months.length} month{item.applicable_months.length !== 1 ? 's' : ''} selected
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Structure Modal ───────────────────────────────────────────────────────────

function StructureModal({
  classes,
  editingStructure,
  onClose,
  onSaved,
}: {
  classes: ClassOption[]
  editingStructure: StructureWithItems | null
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!editingStructure

  const [form, setForm] = useState<StructureForm>(() => {
    if (editingStructure) {
      return {
        name:               editingStructure.name,
        class_id:           editingStructure.class_id ?? '',
        academic_year:      editingStructure.academic_year,
        year_start_month:   String(editingStructure.year_start_month),
        year_end_month:     String(editingStructure.year_end_month),
        due_day_of_month:   String(editingStructure.due_day_of_month),
        late_fee_enabled:   editingStructure.late_fee_enabled,
        late_fee_type:      editingStructure.late_fee_type ?? 'fixed',
        late_fee_value:     String(editingStructure.late_fee_value ?? ''),
        late_fee_grace_days:String(editingStructure.late_fee_grace_days ?? 10),
        items: editingStructure.items.map(item => ({
          id:                item.id,
          fee_type:          item.fee_type as FeeModuleType,
          label:             item.label,
          amount:            String(item.amount),
          frequency:         item.frequency as FeeFrequency,
          applicable_months: item.applicable_months ?? [],
          quarterly_months:  (item.quarterly_months ?? []).map(String),
          is_enabled:        item.is_enabled,
        })),
      }
    }
    return { ...BLANK_FORM, items: [{ ...BLANK_ITEM }] }
  })

  const [saving, setSaving]             = useState(false)
  const [generating, setGenerating]     = useState(false)
  const [error, setError]               = useState('')
  const [generateMsg, setGenerateMsg]   = useState('')

  function setField<K extends keyof StructureForm>(key: K, value: StructureForm[K]) {
    setForm(f => ({ ...f, [key]: value }))
  }

  function addItem() {
    setForm(f => ({
      ...f,
      items: [...f.items, { ...BLANK_ITEM, fee_type: 'custom', label: '' }],
    }))
  }

  function removeItem(index: number) {
    setForm(f => ({ ...f, items: f.items.filter((_, i) => i !== index) }))
  }

  function updateItem(index: number, updated: ItemForm) {
    setForm(f => ({
      ...f,
      items: f.items.map((item, i) => i === index ? updated : item),
    }))
  }

  // Validation
  function validate(): string {
    if (!form.name.trim())   return 'Structure name is required'
    if (!form.class_id)      return 'Please select a class'
    if (!form.academic_year) return 'Academic year is required'
    for (const [i, item] of Array.from(form.items.entries())) {
      if (!item.label.trim())        return `Item ${i + 1}: Label is required`
      if (!item.amount || parseFloat(item.amount) < 0) return `Item ${i + 1}: Enter a valid amount`
      if (item.frequency === 'custom' && item.applicable_months.length === 0)
        return `Item ${i + 1}: Select at least one month for custom frequency`
      if (item.frequency === 'quarterly' && item.quarterly_months.length === 0)
        return `Item ${i + 1}: Select at least one month for quarterly frequency`
    }
    if (form.late_fee_enabled) {
      if (!form.late_fee_value || parseFloat(form.late_fee_value) <= 0)
        return 'Enter a valid late fee amount'
    }
    return ''
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const err = validate()
    if (err) { setError(err); return }

    setSaving(true)
    setError('')
    const supabase = createClient()

    // Get school_id from profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('school_id')
      .single()

    if (!profile?.school_id) {
      setError('Could not get school information')
      setSaving(false)
      return
    }

    const structurePayload = {
      school_id:          profile.school_id,
      class_id:           form.class_id || null,
      name:               form.name.trim(),
      academic_year:      form.academic_year,
      year_start_month:   parseInt(form.year_start_month),
      year_end_month:     parseInt(form.year_end_month),
      due_day_of_month:   parseInt(form.due_day_of_month),
      late_fee_enabled:   form.late_fee_enabled,
      late_fee_type:      form.late_fee_enabled ? form.late_fee_type : null,
      late_fee_value:     form.late_fee_enabled ? parseFloat(form.late_fee_value) : 0,
      late_fee_grace_days:parseInt(form.late_fee_grace_days),
      is_active:          true,
    }

    let structureId: string

    if (isEdit && editingStructure) {
      // Update existing structure
      const { error: updateErr } = await supabase
        .from('fee_structures')
        .update(structurePayload)
        .eq('id', editingStructure.id)

      if (updateErr) { setError(updateErr.message); setSaving(false); return }
      structureId = editingStructure.id

      // Delete old items and re-insert (simplest approach for edit)
      await supabase
        .from('fee_structure_items')
        .delete()
        .eq('fee_structure_id', structureId)

    } else {
      // Create new structure
      const { data: newStructure, error: insertErr } = await supabase
        .from('fee_structures')
        .insert(structurePayload)
        .select('id')
        .single()

      if (insertErr || !newStructure) { setError(insertErr?.message ?? 'Failed to save'); setSaving(false); return }
      structureId = newStructure.id
    }

    // Insert all fee items
    const itemsPayload = form.items.map((item, i) => ({
      school_id:         profile.school_id,
      fee_structure_id:  structureId,
      fee_type:          item.fee_type,
      label:             item.label.trim(),
      amount:            parseFloat(item.amount),
      frequency:         item.frequency,
      applicable_months: item.frequency === 'custom'    ? item.applicable_months : null,
      quarterly_months:  item.frequency === 'quarterly' ? item.quarterly_months.map(Number) : null,
      is_enabled:        item.is_enabled,
      sort_order:        i,
    }))

    const { error: itemsErr } = await supabase
      .from('fee_structure_items')
      .insert(itemsPayload)

    if (itemsErr) { setError(itemsErr.message); setSaving(false); return }

    setSaving(false)
    onSaved()
  }

  async function handleGenerateDues() {
    if (!editingStructure) return
    setGenerating(true)
    setGenerateMsg('')
    setError('')

    try {
      const supabase = createClient()
      const currentMonth = new Date().toISOString().slice(0, 7) // YYYY-MM

      const { data, error: rpcError } = await supabase.rpc('generate_fee_dues_capped', {
        p_fee_structure_id: editingStructure.id,
        p_until_month:      currentMonth,
      })

      if (rpcError) {
        setError(rpcError.message)
      } else {
        const result = Array.isArray(data) ? data[0] : data
        const generated = result?.generated_count ?? 0
        const skipped   = result?.skipped_count   ?? 0
        setGenerateMsg(
          generated === 0
            ? `All dues already up to date (${skipped} skipped)`
            : `Generated ${generated} due${generated !== 1 ? 's' : ''} — ${skipped} already existed`
        )
      }
    } catch (err) {
      setError('Unexpected error — try again')
    } finally {
      setGenerating(false)
    }
  }

  // Total monthly fee preview
  const monthlyTotal = form.items
    .filter(i => i.is_enabled && i.frequency === 'monthly')
    .reduce((sum, i) => sum + (parseFloat(i.amount) || 0), 0)

  const totalItems = form.items.filter(i => i.is_enabled).length

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 px-4 py-6 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl my-auto">

        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-100">
          <div>
            <h2 className="font-semibold text-slate-900">
              {isEdit ? 'Edit fee structure' : 'New fee structure'}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Define what fees this class pays and how often
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100"
          >
            <X size={18} className="text-slate-500" />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-5 flex flex-col gap-5">

          {/* ── Section 1: Basic info ─────────────────────────────────────── */}
          <div className="flex flex-col gap-3">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Basic info</p>

            <div>
              <label className="label">Structure name *</label>
              <input
                type="text"
                className="input"
                placeholder="e.g. Class 8 Standard - 2025-26"
                value={form.name}
                onChange={e => setField('name', e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Class *</label>
                <select
                  className="input"
                  value={form.class_id}
                  onChange={e => setField('class_id', e.target.value)}
                >
                  <option value="">Select class</option>
                  {classes.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name}{c.section ? ` - ${c.section}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Academic year *</label>
                <select
                  className="input"
                  value={form.academic_year}
                  onChange={e => setField('academic_year', e.target.value)}
                >
                  {ACADEMIC_YEAR_OPTIONS.map(y => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label">Year starts</label>
                <select
                  className="input"
                  value={form.year_start_month}
                  onChange={e => setField('year_start_month', e.target.value)}
                >
                  {MONTH_OPTIONS.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Year ends</label>
                <select
                  className="input"
                  value={form.year_end_month}
                  onChange={e => setField('year_end_month', e.target.value)}
                >
                  {MONTH_OPTIONS.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Due on day</label>
                <input
                  type="number"
                  className="input"
                  min={1}
                  max={28}
                  value={form.due_day_of_month}
                  onChange={e => setField('due_day_of_month', e.target.value)}
                />
                <p className="text-[11px] text-slate-400 mt-0.5">1–28 of each month</p>
              </div>
            </div>
          </div>

          {/* ── Section 2: Fee items ──────────────────────────────────────── */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Fee items
              </p>
              {totalItems > 0 && monthlyTotal > 0 && (
                <span className="text-xs text-brand-600 font-medium">
                  Monthly total: {formatCurrency(monthlyTotal)}
                </span>
              )}
            </div>

            {form.items.map((item, i) => (
              <FeeItemRow
                key={i}
                item={item}
                index={i}
                academicYear={form.academic_year}
                yearStartMonth={form.year_start_month}
                onChange={updateItem}
                onRemove={removeItem}
                canRemove={form.items.length > 1}
              />
            ))}

            <button
              type="button"
              onClick={addItem}
              className="flex items-center gap-2 text-sm text-brand-600 hover:text-brand-700 font-medium py-2 border border-dashed border-brand-200 rounded-xl justify-center hover:bg-brand-50 transition-colors"
            >
              <Plus size={15} /> Add fee item
            </button>
          </div>

          {/* ── Section 3: Late fee ───────────────────────────────────────── */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Late fee</p>
              <button
                type="button"
                onClick={() => setField('late_fee_enabled', !form.late_fee_enabled)}
                className="flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-brand-600 transition-colors"
              >
                {form.late_fee_enabled
                  ? <ToggleRight size={18} className="text-brand-600" />
                  : <ToggleLeft size={18} />}
                {form.late_fee_enabled ? 'Enabled' : 'Disabled'}
              </button>
            </div>

            {form.late_fee_enabled && (
              <div className="grid grid-cols-3 gap-3 p-3 bg-amber-50 border border-amber-100 rounded-xl">
                <div>
                  <label className="label">Type</label>
                  <select
                    className="input"
                    value={form.late_fee_type}
                    onChange={e => setField('late_fee_type', e.target.value as LateFeeType)}
                  >
                    <option value="fixed">Fixed (₹)</option>
                    <option value="percentage">Percentage (%)</option>
                  </select>
                </div>
                <div>
                  <label className="label">
                    {form.late_fee_type === 'fixed' ? 'Amount (₹)' : 'Percentage (%)'}
                  </label>
                  <input
                    type="number"
                    className="input"
                    min={0}
                    step={form.late_fee_type === 'percentage' ? 0.1 : 1}
                    placeholder={form.late_fee_type === 'fixed' ? '50' : '2'}
                    value={form.late_fee_value}
                    onChange={e => setField('late_fee_value', e.target.value)}
                  />
                </div>
                <div>
                  <label className="label">Grace period (days)</label>
                  <input
                    type="number"
                    className="input"
                    min={0}
                    max={30}
                    value={form.late_fee_grace_days}
                    onChange={e => setField('late_fee_grace_days', e.target.value)}
                  />
                </div>
                <p className="col-span-3 text-[11px] text-amber-700">
                  Late fee applies {form.late_fee_grace_days} days after the due date.
                  {form.late_fee_type === 'fixed'
                    ? ` ₹${form.late_fee_value || 0} added to the unpaid due.`
                    : ` ${form.late_fee_value || 0}% of the net due amount added.`}
                </p>
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 bg-red-50 text-red-600 text-sm px-3 py-2.5 rounded-lg">
              <AlertCircle size={15} className="shrink-0" />
              {error}
            </div>
          )}

          {/* Generate dues success */}
          {generateMsg && (
            <div className="flex items-center gap-2 bg-green-50 text-green-700 text-sm px-3 py-2.5 rounded-lg">
              <CheckCircle2 size={15} className="shrink-0" />
              {generateMsg}
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-col gap-2 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="btn-primary w-full py-2.5"
            >
              {saving
                ? <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Saving...
                  </span>
                : isEdit ? 'Save changes' : 'Create structure'}
            </button>

            {/* Generate dues — only shown when editing an existing saved structure */}
            {isEdit && (
              <button
                type="button"
                onClick={handleGenerateDues}
                disabled={generating}
                className="btn-secondary w-full py-2.5 flex items-center justify-center gap-2"
              >
                {generating
                  ? <><span className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />Generating...</>
                  : <><Zap size={15} className="text-brand-600" />Generate monthly dues for all students</>}
              </button>
            )}

            {isEdit && (
              <p className="text-[11px] text-slate-400 text-center">
                Generating dues is safe to run multiple times — duplicates are automatically skipped.
              </p>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Structure Card ────────────────────────────────────────────────────────────

function StructureCard({
  structure,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  structure: StructureWithItems
  onEdit: () => void
  onToggleActive: () => void
  onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)

  const enabledItems = structure.items.filter(i => i.is_enabled)
  const monthlyTotal = enabledItems
    .filter(i => i.frequency === 'monthly')
    .reduce((sum, i) => sum + Number(i.amount), 0)

  const className = structure.classes
    ? `${structure.classes.name}${structure.classes.section ? ' - ' + structure.classes.section : ''}`
    : 'No class assigned'

  return (
    <div className={`card p-0 overflow-hidden transition-opacity ${structure.is_active ? '' : 'opacity-60'}`}>
      {/* Card header */}
      <div className="flex items-center gap-3 p-4">
        <div className="w-10 h-10 bg-brand-50 rounded-xl flex items-center justify-center shrink-0">
          <GraduationCap size={19} className="text-brand-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-slate-900 text-sm truncate">{structure.name}</p>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-xs text-slate-500">{className}</span>
            <span className="text-slate-300">·</span>
            <span className="text-xs text-slate-500">{structure.academic_year}</span>
            {monthlyTotal > 0 && (
              <>
                <span className="text-slate-300">·</span>
                <span className="text-xs text-brand-600 font-medium">
                  {formatCurrency(monthlyTotal)}/mo
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
            structure.is_active
              ? 'bg-green-50 text-green-700'
              : 'bg-slate-100 text-slate-500'
          }`}>
            {structure.is_active ? 'Active' : 'Inactive'}
          </span>
          <button
            onClick={() => setExpanded(e => !e)}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-400"
          >
            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        </div>
      </div>

      {/* Items preview */}
      {expanded && (
        <div className="border-t border-slate-100">
          <div className="px-4 py-3 flex flex-col gap-2">
            {enabledItems.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-2">No active fee items</p>
            ) : (
              enabledItems.map(item => (
                <div key={item.id} className="flex items-center justify-between text-sm">
                  <div>
                    <span className="text-slate-700 font-medium">{item.label}</span>
                    <span className="text-xs text-slate-400 ml-2 capitalize">
                      · {FREQUENCY_OPTIONS.find(f => f.value === item.frequency)?.label}
                    </span>
                  </div>
                  <span className="font-semibold text-slate-800">
                    {formatCurrency(Number(item.amount))}
                  </span>
                </div>
              ))
            )}

            {structure.late_fee_enabled && (
              <div className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 px-2.5 py-1.5 rounded-lg mt-1">
                <Clock size={11} />
                Late fee: {structure.late_fee_type === 'fixed'
                  ? `₹${structure.late_fee_value} after ${structure.late_fee_grace_days} days`
                  : `${structure.late_fee_value}% after ${structure.late_fee_grace_days} days`}
              </div>
            )}
          </div>

          {/* Card actions */}
          <div className="flex border-t border-slate-100">
            <button
              onClick={onEdit}
              className="flex-1 py-2.5 text-xs font-medium text-brand-600 hover:bg-brand-50 transition-colors flex items-center justify-center gap-1.5"
            >
              <Settings size={12} /> Edit & Generate
            </button>
            <div className="w-px bg-slate-100" />
            <button
              onClick={onToggleActive}
              className="flex-1 py-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
            >
              {structure.is_active ? 'Deactivate' : 'Activate'}
            </button>
            <div className="w-px bg-slate-100" />
            <button
              onClick={onDelete}
              className="flex-1 py-2.5 text-xs font-medium text-red-500 hover:bg-red-50 transition-colors flex items-center justify-center gap-1.5"
            >
              <Trash2 size={12} /> Delete
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function FeeStructuresPage() {
  const [structures, setStructures]       = useState<StructureWithItems[]>([])
  const [classes, setClasses]             = useState<ClassOption[]>([])
  const [loading, setLoading]             = useState(true)
  const [denied, setDenied]               = useState(false)
  const [showModal, setShowModal]         = useState(false)
  const [editingStructure, setEditingStructure] = useState<StructureWithItems | null>(null)

  const fetchData = useCallback(async () => {
    const supabase = createClient()

    // Fee Structures is admin/principal only. Middleware already blocks
    // other roles from this route; this is a defensive in-page guard.
    const { data: profile } = await supabase.from('profiles').select('role').single()
    const role = (profile as any)?.role
    if (!['school_admin', 'principal', 'super_admin'].includes(role)) {
      setDenied(true)
      setLoading(false)
      return
    }

    const [structuresRes, classesRes] = await Promise.all([
      supabase
        .from('fee_structures')
        .select('*, classes(name, section), fee_structure_items(*)')
        .order('created_at', { ascending: false }),
      supabase
        .from('classes')
        .select('id, name, section')
        .order('name'),
    ])

    // Normalize items from join
    const raw = (structuresRes.data ?? []) as any[]
    const normalized: StructureWithItems[] = raw.map(s => ({
      ...s,
      classes: Array.isArray(s.classes) ? s.classes[0] ?? null : s.classes,
      items:   (s.fee_structure_items ?? []) as FeeStructureItem[],
    }))

    setStructures(normalized)
    setClasses((classesRes.data ?? []) as ClassOption[])
    setLoading(false)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  async function handleToggleActive(structure: StructureWithItems) {
    const supabase = createClient()
    await supabase
      .from('fee_structures')
      .update({ is_active: !structure.is_active })
      .eq('id', structure.id)
    fetchData()
  }

  async function handleDelete(structure: StructureWithItems) {
    if (!confirm(`Delete "${structure.name}"? This will also delete all generated dues and cannot be undone.`)) return
    const supabase = createClient()
    await supabase.from('fee_structures').delete().eq('id', structure.id)
    fetchData()
  }

  function handleEdit(structure: StructureWithItems) {
    setEditingStructure(structure)
    setShowModal(true)
  }

  function handleNew() {
    setEditingStructure(null)
    setShowModal(true)
  }

  function handleModalClose() {
    setShowModal(false)
    setEditingStructure(null)
  }

  function handleSaved() {
    handleModalClose()
    fetchData()
  }

  // ── Global due generation ──────────────────────────────────────────────────
  const [globalGenerating, setGlobalGenerating] = useState(false)
  const [globalGenMsg, setGlobalGenMsg]         = useState<{
    rows: Array<{ structure_name: string; generated_count: number; skipped_count: number }>
    error: string | null
  } | null>(null)

  async function handleGlobalGenerate() {
    if (!confirm('Generate dues for all active fee structures up to the current month?\n\nAlready-generated dues will be skipped automatically.')) return
    setGlobalGenerating(true)
    setGlobalGenMsg(null)
    try {
      const supabase = createClient()
      const { data, error } = await supabase.rpc('trigger_manual_due_generation')
      if (error) {
        setGlobalGenMsg({ rows: [], error: error.message })
      } else {
        setGlobalGenMsg({ rows: (data ?? []) as any[], error: null })
        fetchData()
      }
    } catch (e: any) {
      setGlobalGenMsg({ rows: [], error: e.message ?? 'Unknown error' })
    } finally {
      setGlobalGenerating(false)
    }
  }

  // Stats
  const activeCount   = structures.filter(s => s.is_active).length
  const classesCount  = new Set(structures.filter(s => s.class_id).map(s => s.class_id)).size

  if (denied) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="card">
          <h1 className="text-lg font-semibold text-slate-900 mb-1">Fee Structures</h1>
          <p className="text-sm text-slate-500">
            Only an admin or principal can manage fee structures.
          </p>
          <Link href="/dashboard/fees" className="btn-secondary text-sm inline-block mt-3">
            Back to fees
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Fee Structures</h1>
          <p className="text-slate-500 text-sm mt-1">
            Define fee templates per class. Once saved, generate monthly dues automatically.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleGlobalGenerate}
            disabled={globalGenerating}
            className="btn-secondary flex items-center gap-2 text-sm"
            title="Generate dues for all active structures up to current month"
          >
            <RefreshCw size={15} className={globalGenerating ? 'animate-spin' : ''} />
            {globalGenerating ? 'Generating…' : 'Generate dues'}
          </button>
          <button
            onClick={handleNew}
            className="btn-primary flex items-center gap-2 text-sm"
          >
            <Plus size={16} /> New structure
          </button>
        </div>
      </div>

      {/* Global generate result banner */}
      {globalGenMsg && (
        <div className={`rounded-xl border px-4 py-3 mb-5 ${
          globalGenMsg.error
            ? 'bg-red-50 border-red-200'
            : 'bg-green-50 border-green-200'
        }`}>
          {globalGenMsg.error ? (
            <div className="flex items-center gap-2 text-red-700 text-sm">
              <AlertCircle size={15} className="shrink-0" />
              {globalGenMsg.error}
            </div>
          ) : globalGenMsg.rows.length === 0 ? (
            <div className="flex items-center gap-2 text-green-700 text-sm">
              <CheckCircle2 size={15} className="shrink-0" />
              No active fee structures found to generate dues for.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-green-800 text-sm font-semibold mb-2">
                <ListChecks size={15} className="shrink-0" />
                Due generation complete
              </div>
              <div className="flex flex-col gap-1">
                {globalGenMsg.rows.map((row, i) => (
                  <div key={i} className="flex items-center justify-between text-sm text-green-700">
                    <span className="truncate mr-3">{row.structure_name}</span>
                    <span className="shrink-0 text-xs">
                      <span className="font-semibold">{row.generated_count}</span> generated
                      {row.skipped_count > 0 && (
                        <span className="text-green-500 ml-1.5">· {row.skipped_count} skipped</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
              <button
                onClick={() => setGlobalGenMsg(null)}
                className="text-xs text-green-600 hover:text-green-800 mt-2"
              >
                Dismiss
              </button>
            </>
          )}
        </div>
      )}

      {/* Stats */}
      {!loading && structures.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="stat-card">
            <div className="w-9 h-9 bg-brand-50 rounded-lg flex items-center justify-center mb-3">
              <Settings size={17} className="text-brand-600" />
            </div>
            <p className="text-2xl font-bold text-slate-900">{structures.length}</p>
            <p className="text-xs text-slate-500">Total structures</p>
          </div>
          <div className="stat-card">
            <div className="w-9 h-9 bg-green-50 rounded-lg flex items-center justify-center mb-3">
              <CheckCircle2 size={17} className="text-green-600" />
            </div>
            <p className="text-2xl font-bold text-slate-900">{activeCount}</p>
            <p className="text-xs text-slate-500">Active</p>
          </div>
          <div className="stat-card">
            <div className="w-9 h-9 bg-blue-50 rounded-lg flex items-center justify-center mb-3">
              <GraduationCap size={17} className="text-blue-600" />
            </div>
            <p className="text-2xl font-bold text-slate-900">{classesCount}</p>
            <p className="text-xs text-slate-500">Classes covered</p>
          </div>
        </div>
      )}

      {/* Info banner — first time */}
      {!loading && structures.length === 0 && (
        <div className="bg-brand-50 border border-brand-100 rounded-2xl p-6 mb-6">
          <div className="flex gap-4">
            <div className="w-10 h-10 bg-brand-100 rounded-xl flex items-center justify-center shrink-0">
              <Zap size={18} className="text-brand-600" />
            </div>
            <div>
              <p className="font-semibold text-brand-900 text-sm">How fee structures work</p>
              <p className="text-sm text-brand-700 mt-1 leading-relaxed">
                Create one structure per class. Add fee items (tuition, transport, etc.) and set their frequency.
                Once saved, click <strong>Generate monthly dues</strong> to auto-create dues for all students in that class.
                No manual monthly entry needed.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div className="flex flex-col gap-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="card p-4 animate-pulse">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-slate-100 rounded-xl" />
                <div className="flex-1">
                  <div className="h-4 w-48 bg-slate-100 rounded mb-2" />
                  <div className="h-3 w-32 bg-slate-100 rounded" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : structures.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <IndianRupee size={24} className="text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-900 mb-1">No fee structures yet</h3>
          <p className="text-sm text-slate-500 mb-5">
            Create your first structure to start automating monthly dues
          </p>
          <button onClick={handleNew} className="btn-primary text-sm">
            + Create first structure
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {structures.map(s => (
            <StructureCard
              key={s.id}
              structure={s}
              onEdit={() => handleEdit(s)}
              onToggleActive={() => handleToggleActive(s)}
              onDelete={() => handleDelete(s)}
            />
          ))}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <StructureModal
          classes={classes}
          editingStructure={editingStructure}
          onClose={handleModalClose}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}
