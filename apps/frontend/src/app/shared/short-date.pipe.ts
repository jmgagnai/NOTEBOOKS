import { DatePipe } from '@angular/common';
import { inject, LOCALE_ID, Pipe, PipeTransform } from '@angular/core';

/**
 * A short date for a list line (NBK-98): "Oct 8" in the current year, "Oct 8,
 * 2025" in any other — a list of Chat Threads or Exchanges spans years, and
 * without the year two dates a year apart read the same. The current year is
 * the viewer's, in their local time. One pipe for every such line, so they
 * cannot drift apart.
 */
@Pipe({ name: 'shortDate', standalone: true })
export class ShortDatePipe implements PipeTransform {
  private readonly date = new DatePipe(inject(LOCALE_ID));

  transform(iso: string): string {
    const thisYear = new Date(iso).getFullYear() === new Date().getFullYear();
    return this.date.transform(iso, thisYear ? 'MMM d' : 'MMM d, y') ?? '';
  }
}
