import { createClient } from '@/utils/supabase/server'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const feeId = searchParams.get('fee_id')

  if (!feeId) {
    return NextResponse.json({ error: 'fee_id is required' }, { status: 400 })
  }

  const supabase = await createClient()

  // Fetch fee with student and school info
  const { data: fee, error } = await supabase
    .from('fees')
    .select(`
      *,
      students (
        full_name,
        parent_name,
        parent_phone,
        classes (name, section)
      ),
      schools:school_id (
        name,
        address,
        phone,
        email
      )
    `)
    .eq('id', feeId)
    .single()

  if (error || !fee) {
    return NextResponse.json({ error: 'Fee not found' }, { status: 404 })
  }

  const student = (fee as any).students
  const school = (fee as any).schools
  const cls = student?.classes

  // Generate HTML receipt
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Receipt ${fee.receipt_number}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      background: #f8fafc;
      display: flex;
      justify-content: center;
      padding: 40px 16px;
    }
    .receipt {
      background: white;
      width: 100%;
      max-width: 480px;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    .header {
      background: #2563eb;
      color: white;
      padding: 28px 28px 24px;
    }
    .school-name { font-size: 20px; font-weight: 700; margin-bottom: 2px; }
    .school-sub { font-size: 13px; opacity: 0.8; }
    .receipt-label {
      margin-top: 16px;
      display: inline-block;
      background: rgba(255,255,255,0.2);
      padding: 4px 12px;
      border-radius: 99px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .body { padding: 28px; }
    .amount-block {
      text-align: center;
      padding: 20px;
      background: #f0f4ff;
      border-radius: 12px;
      margin-bottom: 24px;
    }
    .amount-label { font-size: 12px; color: #64748b; margin-bottom: 4px; }
    .amount { font-size: 36px; font-weight: 800; color: #2563eb; }
    .status-paid {
      display: inline-block;
      background: #dcfce7;
      color: #166534;
      font-size: 12px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 99px;
      margin-top: 6px;
    }
    .status-pending {
      display: inline-block;
      background: #fef9c3;
      color: #854d0e;
      font-size: 12px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 99px;
      margin-top: 6px;
    }
    .section-title {
      font-size: 11px;
      font-weight: 600;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 12px;
    }
    .row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid #f1f5f9;
      font-size: 14px;
    }
    .row:last-child { border-bottom: none; }
    .row-label { color: #64748b; }
    .row-value { font-weight: 500; color: #0f172a; }
    .divider { height: 1px; background: #f1f5f9; margin: 20px 0; }
    .footer {
      text-align: center;
      padding: 16px 28px 24px;
      font-size: 12px;
      color: #94a3b8;
    }
    .powered { margin-top: 6px; font-size: 11px; color: #cbd5e1; }
    @media print {
      body { background: white; padding: 0; }
      .receipt { box-shadow: none; border-radius: 0; max-width: 100%; }
    }
  </style>
</head>
<body>
  <div class="receipt">
    <div class="header">
      <div class="school-name">${school?.name ?? 'School'}</div>
      <div class="school-sub">${school?.address ?? ''} ${school?.phone ? '· ' + school.phone : ''}</div>
      <div class="receipt-label">Fee Receipt</div>
    </div>

    <div class="body">
      <div class="amount-block">
        <div class="amount-label">Amount</div>
        <div class="amount">₹${Number(fee.amount).toLocaleString('en-IN')}</div>
        <div class="${fee.status === 'paid' ? 'status-paid' : 'status-pending'}">
          ${fee.status.toUpperCase()}
        </div>
      </div>

      <div class="section-title">Student details</div>
      <div class="row">
        <span class="row-label">Student name</span>
        <span class="row-value">${student?.full_name ?? '—'}</span>
      </div>
      <div class="row">
        <span class="row-label">Class</span>
        <span class="row-value">${cls ? cls.name + (cls.section ? ' - ' + cls.section : '') : '—'}</span>
      </div>
      <div class="row">
        <span class="row-label">Parent name</span>
        <span class="row-value">${student?.parent_name ?? '—'}</span>
      </div>

      <div class="divider"></div>

      <div class="section-title">Payment details</div>
      <div class="row">
        <span class="row-label">Receipt no.</span>
        <span class="row-value">${fee.receipt_number}</span>
      </div>
      <div class="row">
        <span class="row-label">Fee type</span>
        <span class="row-value" style="text-transform:capitalize">${fee.fee_type}</span>
      </div>
      <div class="row">
        <span class="row-label">Payment method</span>
        <span class="row-value" style="text-transform:capitalize">${fee.payment_method ?? '—'}</span>
      </div>
      <div class="row">
        <span class="row-label">Paid on</span>
        <span class="row-value">${fee.paid_date ? new Date(fee.paid_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '—'}</span>
      </div>
      ${fee.notes ? `
      <div class="row">
        <span class="row-label">Notes</span>
        <span class="row-value">${fee.notes}</span>
      </div>` : ''}
    </div>

    <div class="footer">
      Thank you for your payment.<br/>
      Please keep this receipt for your records.
      <div class="powered">Powered by Schoolium</div>
    </div>
  </div>
</body>
</html>
  `

  return new NextResponse(html, {
    headers: {
      'Content-Type': 'text/html',
    },
  })
}
