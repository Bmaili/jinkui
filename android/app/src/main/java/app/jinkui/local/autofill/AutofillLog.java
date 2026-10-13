package app.jinkui.local.autofill;

import android.content.Context;
import android.content.SharedPreferences;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 自动填充的诊断记录（规格 6.5）：每一步发生了什么，存在本机，设置里可以查看、复制。
 * 只记 app 包名、网址域名、认出了哪些输入框这类信息，绝不记账号、密码。最多保留 80 行。
 */
public final class AutofillLog {

    private static final String PREFS = "jinkui_autofill_log";
    private static final String KEY = "lines";
    private static final String SEP = "\n";
    private static final int MAX = 80;

    private AutofillLog() {}

    public static synchronized void add(Context ctx, String msg) {
        try {
            SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            List<String> lines = new ArrayList<>(read(p));
            String stamp = new SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.ROOT).format(new Date());
            lines.add(stamp + " " + msg.replace(SEP, " "));
            while (lines.size() > MAX) lines.remove(0);
            p.edit().putString(KEY, String.join(SEP, lines)).apply();
        } catch (Exception ignored) {
            // 诊断记录写不了不影响功能
        }
    }

    public static synchronized List<String> lines(Context ctx) {
        return read(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE));
    }

    public static synchronized void clear(Context ctx) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).apply();
    }

    private static List<String> read(SharedPreferences p) {
        String s = p.getString(KEY, "");
        if (s == null || s.isEmpty()) return new ArrayList<>();
        return new ArrayList<>(Arrays.asList(s.split(SEP)));
    }

    /** 一个请求的概况：来自哪里、认出了哪些框 */
    public static String describe(FieldParser.Result r) {
        return "app=" + r.packageName + (r.webDomain != null ? " 网址=" + r.webDomain : "")
            + " 账号框=" + (r.usernameId != null ? "有" : "无") + " 密码框=" + (r.passwordId != null ? "有" : "无");
    }
}
