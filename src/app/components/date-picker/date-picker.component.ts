import { OverlayModule } from '@angular/cdk/overlay';
import { Component, computed, forwardRef, input, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

import { formatDate } from '../../shared/date-utils';

interface DayCell {
  date: Date;
  inMonth: boolean;
  isToday: boolean;
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/**
 * Reusable calendar date-picker built on the (already-installed, free)
 * `@angular/cdk` overlay — no CoreUI PRO / paid dependency. Implements
 * ControlValueAccessor so it drops into template- and reactive forms.
 */
@Component({
  selector: 'app-date-picker',
  templateUrl: './date-picker.component.html',
  styleUrls: ['./date-picker.component.scss'],
  imports: [OverlayModule],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => DatePickerComponent),
      multi: true
    }
  ]
})
export class DatePickerComponent implements ControlValueAccessor {
  readonly placeholder = input('Select date');

  readonly open = signal(false);
  readonly disabled = signal(false);
  readonly value = signal<Date | null>(null);
  readonly viewDate = signal<Date>(startOfMonth(new Date()));

  readonly weekdays = WEEKDAYS;

  private onChange: (value: Date | null) => void = () => {};
  private onTouched: () => void = () => {};

  readonly display = computed(() => {
    const v = this.value();
    return v ? formatDate(v) : '';
  });

  readonly monthLabel = computed(() => {
    const d = this.viewDate();
    return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  });

  readonly days = computed<DayCell[]>(() => {
    const first = startOfMonth(this.viewDate());
    const start = new Date(first);
    start.setDate(first.getDate() - first.getDay()); // back to Sunday
    const today = new Date();
    const cells: DayCell[] = [];
    for (let i = 0; i < 42; i++) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      cells.push({
        date,
        inMonth: date.getMonth() === first.getMonth(),
        isToday: sameDay(date, today)
      });
    }
    return cells;
  });

  toggle(): void {
    if (this.disabled()) {
      return;
    }
    this.open.update((o) => !o);
    if (this.open() && this.value()) {
      this.viewDate.set(startOfMonth(this.value()!));
    }
  }

  close(): void {
    if (this.open()) {
      this.open.set(false);
      this.onTouched();
    }
  }

  prevMonth(event: Event): void {
    event.stopPropagation();
    this.shiftMonth(-1);
  }

  nextMonth(event: Event): void {
    event.stopPropagation();
    this.shiftMonth(1);
  }

  select(cell: DayCell): void {
    this.value.set(cell.date);
    this.onChange(cell.date);
    this.onTouched();
    this.close();
  }

  isSelected(date: Date): boolean {
    const v = this.value();
    return !!v && sameDay(v, date);
  }

  private shiftMonth(delta: number): void {
    const d = new Date(this.viewDate());
    d.setMonth(d.getMonth() + delta);
    this.viewDate.set(startOfMonth(d));
  }

  // --- ControlValueAccessor -------------------------------------------------
  writeValue(value: Date | string | null): void {
    const d = value ? new Date(value) : null;
    this.value.set(d && !Number.isNaN(d.getTime()) ? d : null);
    if (this.value()) {
      this.viewDate.set(startOfMonth(this.value()!));
    }
  }

  registerOnChange(fn: (value: Date | null) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
