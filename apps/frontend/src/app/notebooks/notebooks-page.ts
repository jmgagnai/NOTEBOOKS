import { Component, inject, OnInit } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatListModule } from '@angular/material/list';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { NotebooksStore } from './notebooks.store';

/**
 * The one real page for this walking skeleton: loads Notebooks through the
 * generated ng-openapi-gen client (via NotebooksStore) and displays them,
 * proving the Zod -> OpenAPI -> generated client -> Angular chain end to end.
 */
@Component({
  selector: 'app-notebooks-page',
  standalone: true,
  imports: [MatCardModule, MatListModule, MatProgressSpinnerModule],
  templateUrl: './notebooks-page.html',
  styleUrl: './notebooks-page.scss',
})
export class NotebooksPage implements OnInit {
  protected readonly store = inject(NotebooksStore);

  ngOnInit(): void {
    void this.store.loadNotebooks();
  }
}
