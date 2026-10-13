package app.jinkui.local.autofill;

import android.annotation.TargetApi;
import android.app.assist.AssistStructure;
import android.os.Build;
import android.text.InputType;
import android.util.Pair;
import android.view.View;
import android.view.ViewStructure;
import android.view.autofill.AutofillId;
import android.view.autofill.AutofillValue;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 从系统给的页面结构（AssistStructure）里找出账号框和密码框（规格 5.8）。
 *
 * 判断依据按可靠程度：
 * 1. app 自己声明的自动填充提示（autofillHints），网页的 autocomplete / type 属性；
 * 2. 输入类型（密码类、邮箱类）；
 * 3. 控件 ID、提示文字、网页 name/id 里的关键词（user、login、账号、密码……）。
 * 找到密码框但没认出账号框时，取密码框前面最近的一个文本框当账号框（大多数登录页都是这样排的）。
 */
@TargetApi(Build.VERSION_CODES.O)
public final class FieldParser {

    public static final class Result {
        public AutofillId usernameId;
        public AutofillId passwordId;
        public String packageName;
        public String webDomain;
        public String usernameValue;
        public String passwordValue;

        public boolean isEmpty() {
            return usernameId == null && passwordId == null;
        }

        public AutofillId[] ids() {
            List<AutofillId> l = new ArrayList<>();
            if (usernameId != null) l.add(usernameId);
            if (passwordId != null) l.add(passwordId);
            return l.toArray(new AutofillId[0]);
        }
    }

    private static final String[] PASSWORD_WORDS = {"password", "passwd", "passcode", "pwd", "pass_word", "密码", "口令"};
    private static final String[] USERNAME_WORDS = {
        "user", "login", "email", "e-mail", "mail", "account", "acct", "phone", "mobile", "tel", "uid", "loginname",
        "账号", "帐号", "账户", "帐户", "用户", "手机", "邮箱", "登录名"
    };
    private static final String[] SKIP_WORDS = {"search", "query", "captcha", "verify", "otp", "sms", "搜索", "验证码", "校验码"};

    private FieldParser() {}

    public static Result parse(AssistStructure s) {
        Result r = new Result();
        if (s == null) return r;
        if (s.getActivityComponent() != null) r.packageName = s.getActivityComponent().getPackageName();
        List<AssistStructure.ViewNode> nodes = new ArrayList<>();
        for (int i = 0; i < s.getWindowNodeCount(); i++) {
            AssistStructure.ViewNode root = s.getWindowNodeAt(i).getRootViewNode();
            if (root != null) collect(root, nodes);
        }
        AssistStructure.ViewNode username = null;
        AssistStructure.ViewNode password = null;
        AssistStructure.ViewNode lastTextBeforePassword = null;
        for (AssistStructure.ViewNode n : nodes) {
            if (r.webDomain == null && n.getWebDomain() != null && !n.getWebDomain().isEmpty()) r.webDomain = n.getWebDomain();
            if (!isEditable(n) || shouldSkip(n)) continue;
            if (isPassword(n)) {
                if (password == null) password = n;
                continue;
            }
            if (username == null && isUsername(n)) username = n;
            if (password == null) lastTextBeforePassword = n;
        }
        if (username == null && password != null) username = lastTextBeforePassword;
        if (username != null) {
            r.usernameId = username.getAutofillId();
            r.usernameValue = textOf(username);
        }
        if (password != null) {
            r.passwordId = password.getAutofillId();
            r.passwordValue = textOf(password);
        }
        return r;
    }

    private static void collect(AssistStructure.ViewNode n, List<AssistStructure.ViewNode> out) {
        if (n.getVisibility() != View.VISIBLE) return;
        out.add(n);
        for (int i = 0; i < n.getChildCount(); i++) collect(n.getChildAt(i), out);
    }

    private static String textOf(AssistStructure.ViewNode n) {
        AutofillValue v = n.getAutofillValue();
        if (v == null || !v.isText()) return null;
        CharSequence t = v.getTextValue();
        return t == null ? null : t.toString();
    }

    private static boolean isEditable(AssistStructure.ViewNode n) {
        if (n.getAutofillId() == null) return false;
        if (n.getAutofillType() == View.AUTOFILL_TYPE_TEXT) return true;
        String cls = n.getClassName();
        if (cls != null && cls.contains("EditText")) return true;
        ViewStructure.HtmlInfo h = n.getHtmlInfo();
        return h != null && "input".equalsIgnoreCase(h.getTag());
    }

    /** 网页属性 */
    private static String attr(AssistStructure.ViewNode n, String name) {
        ViewStructure.HtmlInfo h = n.getHtmlInfo();
        if (h == null || h.getAttributes() == null) return null;
        for (Pair<String, String> p : h.getAttributes()) {
            if (p.first != null && p.first.equalsIgnoreCase(name)) return p.second == null ? "" : p.second.toLowerCase(Locale.ROOT);
        }
        return null;
    }

    /** 用来找关键词的文字：控件 ID、提示文字、网页 name / id / placeholder */
    private static String words(AssistStructure.ViewNode n) {
        StringBuilder b = new StringBuilder();
        if (n.getIdEntry() != null) b.append(n.getIdEntry()).append(' ');
        if (n.getHint() != null) b.append(n.getHint()).append(' ');
        for (String a : new String[] {"name", "id", "placeholder", "aria-label"}) {
            String v = attr(n, a);
            if (v != null) b.append(v).append(' ');
        }
        return b.toString().toLowerCase(Locale.ROOT);
    }

    private static boolean hasHint(AssistStructure.ViewNode n, String... hints) {
        String[] hs = n.getAutofillHints();
        if (hs == null) return false;
        for (String h : hs) {
            if (h == null) continue;
            for (String want : hints) if (h.equalsIgnoreCase(want)) return true;
        }
        return false;
    }

    private static boolean containsAny(String s, String[] words) {
        for (String w : words) if (s.contains(w)) return true;
        return false;
    }

    private static boolean shouldSkip(AssistStructure.ViewNode n) {
        String type = attr(n, "type");
        if (type != null && (type.equals("hidden") || type.equals("submit") || type.equals("button") || type.equals("checkbox")
            || type.equals("radio") || type.equals("search"))) return true;
        if (hasHint(n, View.AUTOFILL_HINT_USERNAME, View.AUTOFILL_HINT_PASSWORD, View.AUTOFILL_HINT_EMAIL_ADDRESS)) return false;
        return containsAny(words(n), SKIP_WORDS);
    }

    private static boolean isPassword(AssistStructure.ViewNode n) {
        if (hasHint(n, View.AUTOFILL_HINT_PASSWORD, "current-password", "new-password", "newPassword", "currentPassword")) return true;
        String type = attr(n, "type");
        if ("password".equals(type)) return true;
        String ac = attr(n, "autocomplete");
        if (ac != null && (ac.contains("current-password") || ac.contains("new-password"))) return true;
        int it = n.getInputType();
        int cls = it & InputType.TYPE_MASK_CLASS;
        int var = it & InputType.TYPE_MASK_VARIATION;
        if (cls == InputType.TYPE_CLASS_TEXT && (var == InputType.TYPE_TEXT_VARIATION_PASSWORD
            || var == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD || var == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)) return true;
        if (cls == InputType.TYPE_CLASS_NUMBER && var == InputType.TYPE_NUMBER_VARIATION_PASSWORD) return true;
        return containsAny(words(n), PASSWORD_WORDS);
    }

    private static boolean isUsername(AssistStructure.ViewNode n) {
        if (hasHint(n, View.AUTOFILL_HINT_USERNAME, View.AUTOFILL_HINT_EMAIL_ADDRESS, View.AUTOFILL_HINT_PHONE, "email", "tel")) return true;
        String type = attr(n, "type");
        if ("email".equals(type) || "tel".equals(type)) return true;
        String ac = attr(n, "autocomplete");
        if (ac != null && (ac.contains("username") || ac.contains("email") || ac.contains("tel"))) return true;
        int it = n.getInputType();
        int var = it & InputType.TYPE_MASK_VARIATION;
        if ((it & InputType.TYPE_MASK_CLASS) == InputType.TYPE_CLASS_TEXT
            && (var == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS || var == InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS)) return true;
        return containsAny(words(n), USERNAME_WORDS);
    }
}
