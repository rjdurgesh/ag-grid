import { ChangeDetectorRef, Component, computed, inject } from '@angular/core';
import { AgGridAngular, ICellRendererAngularComp } from 'ag-grid-angular';
import { ColorModeService } from '@coreui/angular';
import {
  CellClickedEvent,
  ColDef,
  FirstDataRenderedEvent,
  ICellRendererParams
} from 'ag-grid-community';

import { CellDataType } from '../../../shared/models';
import { LoaderComponent } from '../../loader/loader.component';
import { buildDataColumnDefs } from '../grid-columns';
import { DetailRow, olsGridTheme, olsGridThemeDark } from '../grid-data.model';
import { ValueModalService } from '../value-modal/value-modal.service';

/**
 * ag-grid full-width row renderer (free Community feature) used to emulate
 * master/detail. Renders the fetched table content for an expanded parent row
 * in a nested, read-only grid that still handles CLOB/JSON/XML/BLOB cells.
 */
@Component({
  selector: 'app-detail-row',
  imports: [AgGridAngular, LoaderComponent],
  template: `
    <div class="ols-detail">
      <div class="ols-detail__bar">
        <span class="ols-detail__title">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" class="me-1">
            <path d="M2 4h12M2 8h12M2 12h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" />
          </svg>
          {{ tableName }}
        </span>
        @if (data?.content) {
          <span class="ols-detail__count">{{ data.content!.rows.length }} rows</span>
        }
      </div>

      @if (data?.loading) {
        <div class="ols-detail__loading">
          <app-loader variant="skeleton" [rows]="4" message="Loading table content…" />
        </div>
      } @else if (data?.error) {
        <div class="ols-detail__state ols-detail__state--error">{{ data.error }}</div>
      } @else if (data?.content) {
        <div class="ols-detail__grid">
          <ag-grid-angular
            class="ols-grid-inner"
            [theme]="theme()"
            [rowData]="data.content!.rows"
            [columnDefs]="columnDefs"
            [defaultColDef]="defaultColDef"
            [suppressCellFocus]="true"
            [domLayout]="'normal'"
            (cellClicked)="onCellClicked($event)"
          />
        </div>
      }
    </div>
  `,
  styleUrls: ['./detail-row.component.scss']
})
export class DetailRowComponent implements ICellRendererAngularComp {
  private readonly valueModal = inject(ValueModalService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly colorModeService = inject(ColorModeService);

  readonly theme = computed(() => {
    const mode = this.colorModeService.colorMode();
    const dark = mode === 'dark' || (mode === 'auto' && this.colorModeService.getPrefersColorScheme() === 'dark');
    return dark ? olsGridThemeDark : olsGridTheme;
  });
  readonly defaultColDef: ColDef = { resizable: true, sortable: true, minWidth: 110 };

  data!: DetailRow;
  tableName = '';
  columnDefs: ColDef[] = [];

  agInit(params: ICellRendererParams): void {
    this.setup(params);
  }

  refresh(params: ICellRendererParams): boolean {
    this.setup(params);
    return true;
  }


  /** Open the full value for clob/json/xml/blob token cells. */
  onCellClicked(event: CellClickedEvent): void {
    const dataType = (event.colDef.cellRendererParams as { dataType?: CellDataType } | undefined)?.dataType;
    if (dataType) {
      this.valueModal.open({
        type: dataType,
        field: event.colDef.field ?? event.column.getColId(),
        value: event.value
      });
    }
  }

  private setup(params: ICellRendererParams): void {
    this.data = params.data as DetailRow;
    this.tableName = String(this.data?.parent?.['table_name'] ?? 'Content');
    this.columnDefs = this.data?.content ? buildDataColumnDefs(this.data.content.columns) : [];
    if (this.columnDefs.length) {
      // Rebuild once rows are mounted so cell renderers resolve (see GridDataComponent).
      queueMicrotask(() => {
        this.columnDefs = buildDataColumnDefs(this.data.content!.columns);
        this.cdr.markForCheck();
      });
    }
  }
}
