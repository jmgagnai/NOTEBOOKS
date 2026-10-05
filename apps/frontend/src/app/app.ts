import { Component } from '@angular/core';
import { NotebooksPage } from './notebooks/notebooks-page';

@Component({
  imports: [NotebooksPage],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {}
