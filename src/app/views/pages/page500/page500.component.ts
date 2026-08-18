import { Component } from '@angular/core';

import { ErrorPageComponent } from '../error-page/error-page.component';

@Component({
  selector: 'app-page500',
  templateUrl: './page500.component.html',
  imports: [ErrorPageComponent]
})
export class Page500Component {}
