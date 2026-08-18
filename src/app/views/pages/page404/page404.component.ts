import { Component } from '@angular/core';

import { ErrorPageComponent } from '../error-page/error-page.component';

@Component({
  selector: 'app-page404',
  templateUrl: './page404.component.html',
  imports: [ErrorPageComponent]
})
export class Page404Component {}
