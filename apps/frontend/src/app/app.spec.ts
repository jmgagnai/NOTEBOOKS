import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { NotebooksService } from './api/services/notebooks.service';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        // The App shell just hosts NotebooksPage; its own behavior is
        // covered by notebooks-page.spec.ts (the seam-3 test), so the
        // generated client only needs a trivial stub here.
        { provide: NotebooksService, useValue: { listNotebooks: () => Promise.resolve([]) } },
      ],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });
});
