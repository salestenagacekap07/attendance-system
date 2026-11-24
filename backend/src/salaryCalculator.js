/**
 * Salary Calculation Logic for Malaysian Facility & Cleaning Operations
 * Follows exact specifications:
 * - Auto-counts working days per month based on site pattern (Mon-Fri or Mon-Sat).
 * - Excludes Sundays always. Excludes Saturdays for Mon-Fri.
 * - Public Holidays (PH) are NOT working days by default.
 * - If worker works on PH (Present/OT/Half Day), auto-counts PH as a working day.
 * - Per Day Salary = Total Salary / Auto-Counted Working Days
 * - Gross Working Hours = Out Time - In Time (default 09:00 - 17:00 = 8h)
 * - Net Working Hours = Gross Working Hours - Unpaid Break Time (e.g. 8 - 1 = 7h)
 * - Per Hour Salary = Per Day Salary / Net Working Hours
 * - Deductions:
 *    - Absent 1 Day = Deduct 1 x Per Day Salary
 *    - Half Day = Deduct 0.5 x Per Day Salary
 *    - Late: Deduct Per Hour Salary x Late Hours
 * - OT Additions:
 *    - Normal Days (Mon - Sat): 1.5x Hourly Rate
 *    - Rest Days (Sunday) & Public Holidays (PH): 2.0x Hourly Rate
 * - Days Worked Breakdown for Accounts:
 *    - Explicitly tracks regular days, Sundays, Saturdays (extra), and PH days worked
 *    - Generates formula e.g. "5 Working Days + 1 Sunday = 6 Days Worked"
 */

function parseTimeToHours(timeStr) {
  if (!timeStr || typeof timeStr !== 'string' || !timeStr.includes(':')) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return (h || 0) + (m || 0) / 60;
}

function calculateWorkingHours(startTime, endTime, breakMinutes = 60) {
  const start = parseTimeToHours(startTime || '09:00');
  const end = parseTimeToHours(endTime || '17:00');
  const gross = Math.max(0, end - start);
  const breakHours = (Number(breakMinutes) || 0) / 60;
  const net = Math.max(1, gross - breakHours);
  return { gross: Number(gross.toFixed(2)), net: Number(net.toFixed(2)) };
}

function getDateDetails(dateStr) {
  if (!dateStr) return { dateStr: '', dayOfWeek: -1, isSunday: false, isSaturday: false };
  const clean = String(dateStr).substring(0, 10);
  const parts = clean.split('-').map(Number);
  if (parts.length < 3 || isNaN(parts[0]) || isNaN(parts[1]) || isNaN(parts[2])) {
    return { dateStr: clean, dayOfWeek: -1, isSunday: false, isSaturday: false };
  }
  const [y, m, d] = parts;
  const dt = new Date(y, m - 1, d);
  const dayOfWeek = dt.getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  return {
    dateStr: clean,
    dayOfWeek,
    isSunday: dayOfWeek === 0,
    isSaturday: dayOfWeek === 6
  };
}

/**
 * Counts working days for a calendar month given site pattern, public holidays,
 * and worker attendance records on PH days.
 */
function getMonthlyWorkingDays(year, month, pattern = 'Mon-Fri', phDateSet = new Set(), workerAttendanceMap = {}) {
  const totalDays = new Date(year, month, 0).getDate();
  let workingDays = 0;
  const dayBreakdown = [];

  for (let d = 1; d <= totalDays; d++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dateObj = new Date(year, month - 1, d);
    const dayOfWeek = dateObj.getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat

    const isSunday = (dayOfWeek === 0);
    const isSaturday = (dayOfWeek === 6);
    const isPH = phDateSet.has(dateStr);
    const att = workerAttendanceMap[dateStr];
    const workedOnPH = isPH && att && ['Present', 'OT', 'Half Day'].includes(att.status);

    let isStandardWorkingDay = false;
    if (pattern === 'Mon-Sat') {
      isStandardWorkingDay = !isSunday;
    } else {
      // Mon-Fri
      isStandardWorkingDay = !isSunday && !isSaturday;
    }

    let isCountedWorkingDay = false;
    if (isStandardWorkingDay && !isPH) {
      isCountedWorkingDay = true;
    } else if (workedOnPH) {
      // Rule: If worker works on PH, system must auto-count that PH day as a working day
      isCountedWorkingDay = true;
    }

    if (isCountedWorkingDay) {
      workingDays++;
    }

    dayBreakdown.push({
      date: dateStr,
      day: d,
      dayOfWeek,
      isSunday,
      isSaturday,
      isPH,
      workedOnPH,
      isCountedWorkingDay
    });
  }

  return { workingDays, totalDays, dayBreakdown };
}

/**
 * Calculates complete salary breakdown for a worker for a specific month.
 */
function calculateWorkerSalary({
  worker,
  site,
  year,
  month,
  attendanceRecords = [],
  publicHolidays = []
}) {
  const phDateSet = new Set(
    publicHolidays.map(ph => typeof ph === 'string' ? ph : (ph.holiday_date ? ph.holiday_date.substring(0, 10) : ''))
  );

  // Map attendance by date string 'YYYY-MM-DD'
  const attendanceMap = {};
  attendanceRecords.forEach(r => {
    const dStr = typeof r.attendance_date === 'string' ? r.attendance_date.substring(0, 10) : '';
    if (dStr) attendanceMap[dStr] = r;
  });

  const pattern = site.working_days_pattern || 'Mon-Fri';
  const { workingDays, totalDays } = getMonthlyWorkingDays(year, month, pattern, phDateSet, attendanceMap);

  // Working Hours & Net Hours
  const { gross: grossHours, net: netHours } = calculateWorkingHours(
    site.working_time_start || '09:00',
    site.working_time_end || '17:00',
    site.break_time_minutes !== undefined ? site.break_time_minutes : 60
  );

  const isMonthly = (worker.salary_type || 'monthly').toLowerCase() === 'monthly';
  const baseSalary = Number(worker.base_salary) || 0;

  // Aggregate attendance statuses & hours
  let presentDays = 0;
  let absentDays = 0;
  let halfDays = 0;
  let leaveDays = 0;
  let otDays = 0;
  let normalOtHours = 0;      // Mon - Sat (1.5x)
  let restDayPhOtHours = 0;   // Sunday & Public Holiday (2.0x)
  let totalLateHours = 0;

  // Detailed days worked breakdown
  let regularDaysWorked = 0;
  let sundayDaysWorked = 0;
  let saturdayExtraDaysWorked = 0;
  let phDaysWorked = 0;

  attendanceRecords.forEach(r => {
    const status = r.status || 'Present';
    if (status === 'Present') presentDays++;
    else if (status === 'Absent') absentDays++;
    else if (status === 'Half Day') halfDays++;
    else if (status === 'Leave') leaveDays++;
    else if (status === 'OT') {
      otDays++;
      presentDays++; // OT day is also a day worked
    }

    const { dateStr, isSunday, isSaturday } = getDateDetails(r.attendance_date);
    const isPH = phDateSet.has(dateStr);
    const isRestDayOrPH = isSunday || isPH;

    const isWorked = ['Present', 'OT', 'Half Day'].includes(status);
    const weight = status === 'Half Day' ? 0.5 : 1;

    if (isWorked) {
      if (isSunday) {
        sundayDaysWorked += weight;
      } else if (isPH) {
        phDaysWorked += weight;
      } else if (isSaturday && pattern === 'Mon-Fri') {
        saturdayExtraDaysWorked += weight;
      } else {
        regularDaysWorked += weight;
      }
    }

    let otVal = Number(r.ot_hours) || 0;
    // If status is OT and ot_hours wasn't explicitly set, default to net working hours
    if (status === 'OT' && otVal === 0 && r.in_time && r.out_time) {
      const { net } = calculateWorkingHours(r.in_time, r.out_time, site.break_time_minutes || 60);
      otVal = net;
    }

    if (isRestDayOrPH) {
      restDayPhOtHours += otVal;
    } else {
      normalOtHours += otVal;
    }

    totalLateHours += Number(r.late_hours) || 0;
  });

  const totalOtHours = normalOtHours + restDayPhOtHours;
  const totalDaysWorked = regularDaysWorked + sundayDaysWorked + saturdayExtraDaysWorked + phDaysWorked;

  // Build human-readable formula string for Accounts:
  // e.g. "20 Regular Days (Mon-Fri) + 1 Sunday = 21 Days Worked"
  const formulaParts = [];
  if (regularDaysWorked > 0) {
    formulaParts.push(`${regularDaysWorked} Normal Working Days`);
  }
  if (saturdayExtraDaysWorked > 0) {
    formulaParts.push(`${saturdayExtraDaysWorked} Sat Extra`);
  }
  if (sundayDaysWorked > 0) {
    formulaParts.push(`${sundayDaysWorked} Sunday`);
  }
  if (phDaysWorked > 0) {
    formulaParts.push(`${phDaysWorked} Public Holiday`);
  }

  let daysWorkedFormula = '';
  if (formulaParts.length > 1) {
    daysWorkedFormula = `${formulaParts.join(' + ')} = Total ${totalDaysWorked} Days`;
  } else if (formulaParts.length === 1) {
    daysWorkedFormula = `${formulaParts[0]} = Total ${totalDaysWorked} Days`;
  } else {
    daysWorkedFormula = `0 Days Worked`;
  }

  let perDaySalary = 0;
  let perHourSalary = 0;
  let absentDeduction = 0;
  let halfDayDeduction = 0;
  let lateDeduction = 0;
  let normalOtPay = 0;
  let restDayPhOtPay = 0;
  let otPay = 0;
  let grossSalary = 0;
  let netSalary = 0;

  if (isMonthly) {
    // A) Monthly Salary Workers (Cleaner, Landscaper if monthly)
    // Per Day Salary = Total Salary Per Month / Auto-Counted Working Days
    perDaySalary = workingDays > 0 ? Number((baseSalary / workingDays).toFixed(2)) : 0;
    // Per Hour Salary = Per Day Salary / Net Working Hours
    perHourSalary = netHours > 0 ? Number((perDaySalary / netHours).toFixed(2)) : 0;

    // Deductions:
    absentDeduction = Number((absentDays * perDaySalary).toFixed(2));
    halfDayDeduction = Number((halfDays * 0.5 * perDaySalary).toFixed(2));
    lateDeduction = Number((totalLateHours * perHourSalary).toFixed(2));
    const totalDeductions = Number((absentDeduction + halfDayDeduction + lateDeduction).toFixed(2));

    // OT Pay:
    // Normal Days (Mon - Sat): 1.5x Hourly Rate
    // Sunday & Public Holiday (PH): 2.0x Hourly Rate
    normalOtPay = Number((normalOtHours * perHourSalary * 1.5).toFixed(2));
    restDayPhOtPay = Number((restDayPhOtHours * perHourSalary * 2.0).toFixed(2));
    otPay = Number((normalOtPay + restDayPhOtPay).toFixed(2));

    grossSalary = baseSalary;
    netSalary = Number(Math.max(0, baseSalary - totalDeductions + otPay).toFixed(2));

    return {
      worker_id: worker.id,
      worker_name: worker.name,
      employee_code: worker.employee_code,
      worker_type: worker.worker_type,
      salary_type: 'monthly',
      base_salary: baseSalary,
      pattern,
      calendar_days: totalDays,
      auto_counted_working_days: workingDays,
      gross_working_hours: grossHours,
      break_time_minutes: site.break_time_minutes || 60,
      net_working_hours: netHours,
      per_day_salary: perDaySalary,
      per_hour_salary: perHourSalary,
      days_worked: {
        regular: regularDaysWorked,
        saturday_extra: saturdayExtraDaysWorked,
        sunday: sundayDaysWorked,
        ph: phDaysWorked,
        total_worked: totalDaysWorked,
        formula: daysWorkedFormula
      },
      attendance_summary: {
        present_days: presentDays,
        absent_days: absentDays,
        half_days: halfDays,
        leave_days: leaveDays,
        ot_days: otDays,
        normal_ot_hours: Number(normalOtHours.toFixed(2)),
        rest_day_ph_ot_hours: Number(restDayPhOtHours.toFixed(2)),
        total_ot_hours: Number(totalOtHours.toFixed(2)),
        total_late_hours: Number(totalLateHours.toFixed(2))
      },
      deductions: {
        absent: absentDeduction,
        half_day: halfDayDeduction,
        late: lateDeduction,
        total: totalDeductions
      },
      ot_breakdown: {
        normal_hours: Number(normalOtHours.toFixed(2)),
        normal_pay: normalOtPay,
        rest_ph_hours: Number(restDayPhOtHours.toFixed(2)),
        rest_ph_pay: restDayPhOtPay
      },
      ot_pay: otPay,
      gross_salary: grossSalary,
      net_salary: netSalary
    };
  } else {
    // B) Daily Salary Workers (General Worker, Landscaper if daily)
    const dailyRate = baseSalary;
    perDaySalary = dailyRate;
    perHourSalary = netHours > 0 ? Number((dailyRate / netHours).toFixed(2)) : 0;

    const earnedDays = presentDays + (halfDays * 0.5);
    grossSalary = Number((earnedDays * dailyRate).toFixed(2));

    lateDeduction = Number((totalLateHours * perHourSalary).toFixed(2));

    // OT Pay:
    // Normal Days (Mon - Sat): 1.5x Hourly Rate
    // Sunday & Public Holiday (PH): 2.0x Hourly Rate
    normalOtPay = Number((normalOtHours * perHourSalary * 1.5).toFixed(2));
    restDayPhOtPay = Number((restDayPhOtHours * perHourSalary * 2.0).toFixed(2));
    otPay = Number((normalOtPay + restDayPhOtPay).toFixed(2));

    const totalDeductions = lateDeduction;
    netSalary = Number(Math.max(0, grossSalary - lateDeduction + otPay).toFixed(2));

    return {
      worker_id: worker.id,
      worker_name: worker.name,
      employee_code: worker.employee_code,
      worker_type: worker.worker_type,
      salary_type: 'daily',
      base_salary: dailyRate,
      pattern,
      calendar_days: totalDays,
      auto_counted_working_days: workingDays,
      gross_working_hours: grossHours,
      break_time_minutes: site.break_time_minutes || 60,
      net_working_hours: netHours,
      per_day_salary: perDaySalary,
      per_hour_salary: perHourSalary,
      days_worked: {
        regular: regularDaysWorked,
        saturday_extra: saturdayExtraDaysWorked,
        sunday: sundayDaysWorked,
        ph: phDaysWorked,
        total_worked: totalDaysWorked,
        formula: daysWorkedFormula
      },
      attendance_summary: {
        present_days: presentDays,
        absent_days: absentDays,
        half_days: halfDays,
        leave_days: leaveDays,
        ot_days: otDays,
        normal_ot_hours: Number(normalOtHours.toFixed(2)),
        rest_day_ph_ot_hours: Number(restDayPhOtHours.toFixed(2)),
        total_ot_hours: Number(totalOtHours.toFixed(2)),
        total_late_hours: Number(totalLateHours.toFixed(2))
      },
      deductions: {
        absent: 0,
        half_day: 0,
        late: lateDeduction,
        total: totalDeductions
      },
      ot_breakdown: {
        normal_hours: Number(normalOtHours.toFixed(2)),
        normal_pay: normalOtPay,
        rest_ph_hours: Number(restDayPhOtHours.toFixed(2)),
        rest_ph_pay: restDayPhOtPay
      },
      ot_pay: otPay,
      gross_salary: grossSalary,
      net_salary: netSalary
    };
  }
}

module.exports = {
  calculateWorkingHours,
  getMonthlyWorkingDays,
  calculateWorkerSalary,
  getDateDetails
};
