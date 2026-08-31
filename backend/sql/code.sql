PROCEDURE roll_static_data(
    p_table_name  IN  VARCHAR2,
    p_fromdt      IN  VARCHAR2,
    p_todt        IN  SYS.ODCIVARCHAR2LIST,
    p_tablespace  IN  VARCHAR2,
    p_uid         IN  VARCHAR2,
    p_errmsg      OUT SYS.ODCIVARCHAR2LIST      -- per target date: NULL = success, else the error text
);

PROCEDURE roll_static_data(
    p_table_name  IN  VARCHAR2,
    p_fromdt      IN  VARCHAR2,
    p_todt        IN  SYS.ODCIVARCHAR2LIST,
    p_tablespace  IN  VARCHAR2,
    p_uid         IN  VARCHAR2,
    p_errmsg      OUT SYS.ODCIVARCHAR2LIST,   -- per date: NULL = ok, else error
    p_rows        OUT SYS.ODCINUMBERLIST,     -- per date: rows present after the roll
    p_src_rows    OUT NUMBER                  -- rows at the source date (baseline)
) IS
    fromtdt   DATE := TO_DATE(p_fromdt, 'YYYY-MM-DD');
    todt      DATE;
    v_datecol VARCHAR2(128) := ols_util.get_date_column(p_table_name);   -- COB_DT / REPORTING_DT
    v_cnt     NUMBER;
BEGIN
    p_errmsg := SYS.ODCIVARCHAR2LIST(); p_errmsg.EXTEND(p_todt.COUNT);
    p_rows   := SYS.ODCINUMBERLIST();   p_rows.EXTEND(p_todt.COUNT);

    EXECUTE IMMEDIATE 'SELECT COUNT(*) FROM ' || p_table_name ||
                      ' WHERE ' || v_datecol || ' = :1' INTO p_src_rows USING fromtdt;

    FOR i IN 1 .. p_todt.COUNT LOOP
        BEGIN
            todt := TO_DATE(p_todt(i), 'YYYY-MM-DD');
            ols_roll.rolltable(p_table_name, fromtdt, todt, p_tablespace);
            COMMIT;
            EXECUTE IMMEDIATE 'SELECT COUNT(*) FROM ' || p_table_name ||
                              ' WHERE ' || v_datecol || ' = :1' INTO v_cnt USING todt;
            p_errmsg(i) := NULL;  p_rows(i) := v_cnt;
        EXCEPTION
            WHEN OTHERS THEN
                ROLLBACK;
                p_errmsg(i) := SUBSTR(SQLERRM, 1, 400);  p_rows(i) := NULL;
        END;
    END LOOP;
END roll_static_data;