/// <reference types="@angular/localize" />
import { bootstrapApplication } from '@angular/platform-browser';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';

import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

// Register the free ag-grid Community feature modules once for the whole app.
ModuleRegistry.registerModules([AllCommunityModule]);

bootstrapApplication(AppComponent, appConfig)
  .catch(err => console.error(err));

