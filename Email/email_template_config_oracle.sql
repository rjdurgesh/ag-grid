-- Optional Oracle table for storing Jinja email templates in DB.
-- Keep the canonical template in source control when possible, then deploy/sync it into this table.

create table ols_email_template_config (
  template_code       varchar2(80)   not null,
  template_version    number         default 1 not null,
  subject_template    varchar2(500)  not null,
  body_template_clob  clob           not null,
  is_active           char(1)        default 'Y' not null,
  created_on          timestamp      default systimestamp not null,
  created_by          varchar2(100),
  updated_on          timestamp,
  updated_by          varchar2(100),
  constraint pk_ols_email_template_config primary key (template_code, template_version),
  constraint ck_ols_email_template_active check (is_active in ('Y', 'N'))
);

create index ix_ols_email_template_active
  on ols_email_template_config (template_code, is_active);

-- Example lookup:
--
-- select subject_template, body_template_clob
-- from ols_email_template_config
-- where template_code = :template_code
--   and is_active = 'Y'
-- order by template_version desc
-- fetch first 1 row only;
