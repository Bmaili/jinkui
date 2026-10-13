package app.jinkui.local;

import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PersistableBundle;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 复制密码（规格 6.4）：标记为敏感内容（安卓 13 起不在剪贴板预览、输入法联想里显示），
 * 到时间后清空——如果剪贴板里还是我们复制的内容。后台读不到剪贴板时（安卓 10 起的限制）直接清空。
 *
 * JS：registerPlugin('SecureClipboard')
 *   copy({ text, sensitive, clearAfterMs })
 *   clear()
 */
@CapacitorPlugin(name = "SecureClipboard")
public class SecureClipboardPlugin extends Plugin {

    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable pending;
    private String lastText;

    @PluginMethod
    public void copy(final PluginCall call) {
        final String text = call.getString("text", "");
        final boolean sensitive = Boolean.TRUE.equals(call.getBoolean("sensitive", false));
        final int ms = call.getInt("clearAfterMs", 0);
        getActivity().runOnUiThread(() -> {
            try {
                ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = ClipData.newPlainText("金匮", text);
                if (sensitive) {
                    PersistableBundle extras = new PersistableBundle();
                    if (Build.VERSION.SDK_INT >= 33) extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
                    else extras.putBoolean("android.content.extra.IS_SENSITIVE", true);
                    clip.getDescription().setExtras(extras);
                }
                cm.setPrimaryClip(clip);
                lastText = text;
                if (pending != null) handler.removeCallbacks(pending);
                pending = null;
                if (ms > 0) {
                    pending = this::clearIfOurs;
                    handler.postDelayed(pending, ms);
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
            clearIfOurs();
            call.resolve();
        });
    }

    private void clearIfOurs() {
        if (pending != null) handler.removeCallbacks(pending);
        pending = null;
        if (lastText == null) return;
        try {
            ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            try {
                ClipData cur = cm.getPrimaryClip();
                if (cur != null && cur.getItemCount() > 0) {
                    CharSequence t = cur.getItemAt(0).getText();
                    // 用户之后又复制了别的东西：不动它
                    if (t != null && !t.toString().equals(lastText)) {
                        lastText = null;
                        return;
                    }
                }
            } catch (Exception ignored) {
                // 读不到就当还是我们的
            }
            if (Build.VERSION.SDK_INT >= 28) cm.clearPrimaryClip();
            else cm.setPrimaryClip(ClipData.newPlainText("", ""));
        } catch (Exception ignored) {
            // 清不掉也没办法
        }
        lastText = null;
    }
}
