package app.jinkui.local;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PersistableBundle;
import android.os.SystemClock;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * 复制密码（规格 6.4）：标记为敏感内容（安卓 13 起不在剪贴板预览、输入法联想里显示），
 * 到时间后清空——如果剪贴板里还是我们复制的内容。后台读不到剪贴板时（安卓 10 起的限制）直接清空。
 *
 * 定时用两套：进程里的 Handler，加一个系统闹钟（{@link ClearReceiver}）。“复制密码并返回”之后金匮在后台，
 * 安卓 11 起会把后台的 app 冻结，Handler 就不跑了，密码会一直留在剪贴板里；闹钟会把进程唤起来清掉。
 * 要不要清、清的是不是我们复制的，记在 SharedPreferences 里（只存哈希，不存内容），进程被杀了也知道。
 *
 * JS：registerPlugin('SecureClipboard')
 *   copy({ text, sensitive, clearAfterMs })
 *   clear()
 */
@CapacitorPlugin(name = "SecureClipboard")
public class SecureClipboardPlugin extends Plugin {

    private static final String PREFS = "jinkui_clipboard";
    /** 等着清空的内容的 sha256；没有表示不用清 */
    private static final String KEY_HASH = "pendingHash";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable pending;

    @PluginMethod
    public void copy(final PluginCall call) {
        final String text = call.getString("text", "");
        final boolean sensitive = Boolean.TRUE.equals(call.getBoolean("sensitive", false));
        final int ms = call.getInt("clearAfterMs", 0);
        getActivity().runOnUiThread(() -> {
            try {
                Context ctx = getContext().getApplicationContext();
                ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = ClipData.newPlainText("金匮", text);
                if (sensitive) {
                    PersistableBundle extras = new PersistableBundle();
                    if (Build.VERSION.SDK_INT >= 33) extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
                    else extras.putBoolean("android.content.extra.IS_SENSITIVE", true);
                    clip.getDescription().setExtras(extras);
                }
                cm.setPrimaryClip(clip);
                if (pending != null) handler.removeCallbacks(pending);
                pending = null;
                cancelAlarm(ctx);
                if (ms > 0) {
                    prefs(ctx).edit().putString(KEY_HASH, sha256(text)).apply();
                    pending = () -> clearIfOurs(ctx);
                    handler.postDelayed(pending, ms);
                    scheduleAlarm(ctx, ms);
                } else {
                    prefs(ctx).edit().remove(KEY_HASH).apply();
                }
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "复制失败" : e.getMessage());
            }
        });
    }

    @PluginMethod
    public void clear(final PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (pending != null) handler.removeCallbacks(pending);
            pending = null;
            clearIfOurs(getContext().getApplicationContext());
            call.resolve();
        });
    }

    /** 到时间了：剪贴板里还是我们复制的（或者读不到）就清空 */
    static synchronized void clearIfOurs(Context ctx) {
        SharedPreferences p = prefs(ctx);
        String hash = p.getString(KEY_HASH, null);
        cancelAlarm(ctx);
        if (hash == null) return;
        p.edit().remove(KEY_HASH).apply();
        try {
            ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            try {
                ClipData cur = cm.getPrimaryClip();
                if (cur != null && cur.getItemCount() > 0) {
                    CharSequence t = cur.getItemAt(0).getText();
                    // 用户之后又复制了别的东西：不动它
                    if (t != null && !sha256(t.toString()).equals(hash)) return;
                }
            } catch (Exception ignored) {
                // 读不到就当还是我们的
            }
            if (Build.VERSION.SDK_INT >= 28) cm.clearPrimaryClip();
            else cm.setPrimaryClip(ClipData.newPlainText("", ""));
        } catch (Exception ignored) {
            // 清不掉也没办法
        }
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static PendingIntent alarmIntent(Context ctx) {
        Intent i = new Intent(ctx, ClearReceiver.class);
        return PendingIntent.getBroadcast(ctx, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** 不精确的闹钟（不需要“精确闹钟”权限），可能晚几十秒，但 app 被冻结时也会触发 */
    private static void scheduleAlarm(Context ctx, long ms) {
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am != null) am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + ms, alarmIntent(ctx));
        } catch (Exception ignored) {
            // 定不了闹钟就只靠 Handler 和回到前台时的补清
        }
    }

    private static void cancelAlarm(Context ctx) {
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am != null) am.cancel(alarmIntent(ctx));
        } catch (Exception ignored) {
            // 同上
        }
    }

    private static String sha256(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder b = new StringBuilder();
            for (byte x : d) b.append(String.format("%02x", x));
            return b.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** 系统闹钟到点时由系统调用（在 AndroidManifest.xml 里注册，不对外开放） */
    public static class ClearReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            clearIfOurs(context.getApplicationContext());
        }
    }
}
