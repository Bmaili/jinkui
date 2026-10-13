package app.jinkui.local.autofill;

import android.annotation.TargetApi;
import android.app.PendingIntent;
import android.app.assist.AssistStructure;
import android.content.Intent;
import android.content.IntentSender;
import android.os.Build;
import android.os.CancellationSignal;
import android.service.autofill.AutofillService;
import android.service.autofill.Dataset;
import android.service.autofill.FillCallback;
import android.service.autofill.FillContext;
import android.service.autofill.FillRequest;
import android.service.autofill.FillResponse;
import android.service.autofill.SaveCallback;
import android.service.autofill.SaveInfo;
import android.service.autofill.SaveRequest;
import android.view.autofill.AutofillId;
import android.widget.RemoteViews;
import app.jinkui.local.AutofillActivity;
import app.jinkui.local.R;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 系统自动填充服务（规格 5.8）。在设置里把“自动填充服务”选成金匮后，系统在登录页的输入框上调用这里。
 *
 * - 填充：认出账号框 / 密码框后，只给系统一个“用金匮填充”的提示（需要验证）。用户点它，系统打开
 *   AutofillActivity，验证指纹或主密码、选好条目后把账号密码交回系统填进去。服务本身拿不到任何密码。
 * - 保存：登录后系统问“保存到金匮？”，用户同意后打开 AutofillActivity 的保存界面（安卓 9 起）。
 */
@TargetApi(Build.VERSION_CODES.O)
public class JinkuiAutofillService extends AutofillService {

    public static final String EXTRA_MODE = "jinkui.autofill.mode";
    public static final String EXTRA_TOKEN = "jinkui.autofill.token";
    /** 填充请求里认出的输入框，直接交给填充窗口：窗口不再重新解析页面（重新解析时，有的 app / 浏览器给的输入框标识会变，填不回去） */
    public static final String EXTRA_USERNAME_ID = "jinkui.autofill.usernameId";
    public static final String EXTRA_PASSWORD_ID = "jinkui.autofill.passwordId";
    public static final String EXTRA_PACKAGE = "jinkui.autofill.package";
    public static final String EXTRA_DOMAIN = "jinkui.autofill.domain";
    private static final AtomicInteger REQUEST_CODE = new AtomicInteger(1);

    @Override
    public void onFillRequest(FillRequest request, CancellationSignal cancellationSignal, FillCallback callback) {
        try {
            FieldParser.Result r = parseLatest(request.getFillContexts());
            if (r.isEmpty() || getPackageName().equals(r.packageName)) {
                if (!getPackageName().equals(r.packageName)) AutofillLog.add(this, "填充请求：没认出账号框或密码框 app=" + r.packageName + (r.webDomain != null ? " 网址=" + r.webDomain : ""));
                callback.onSuccess(null);
                return;
            }
            AutofillLog.add(this, "填充请求 " + AutofillLog.describe(r));
            Intent i = new Intent(this, AutofillActivity.class).putExtra(EXTRA_MODE, "fill");
            if (r.usernameId != null) i.putExtra(EXTRA_USERNAME_ID, r.usernameId);
            if (r.passwordId != null) i.putExtra(EXTRA_PASSWORD_ID, r.passwordId);
            if (r.packageName != null) i.putExtra(EXTRA_PACKAGE, r.packageName);
            if (r.webDomain != null) i.putExtra(EXTRA_DOMAIN, r.webDomain);
            int flags = PendingIntent.FLAG_CANCEL_CURRENT;
            // 系统要往这个 Intent 里放页面结构，安卓 12 起必须声明为可变
            if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
            IntentSender sender = PendingIntent.getActivity(this, REQUEST_CODE.getAndIncrement(), i, flags).getIntentSender();

            String where = r.webDomain != null ? r.webDomain : null;
            RemoteViews presentation = presentation(where == null ? "用金匮填充" : "用金匮填充 · " + where);
            // 验证要挂在“这一组数据”（Dataset）上，不能挂在整个 FillResponse 上：
            // 整个响应要验证时，系统只接受窗口交回一个新的 FillResponse，交回 Dataset 会被当成无效结果悄悄丢掉
            // （1.0.3、1.0.4“选了账号却没填进去”的原因）。挂在 Dataset 上，窗口交回 Dataset 后系统直接填入。
            // 值先留空（服务拿不到密码），由窗口交回的 Dataset 替换。
            Dataset.Builder locked = new Dataset.Builder(presentation);
            for (AutofillId id : r.ids()) locked.setValue(id, null);
            locked.setAuthentication(sender);
            FillResponse.Builder b = new FillResponse.Builder().addDataset(locked.build());
            if (r.passwordId != null) {
                int types = SaveInfo.SAVE_DATA_TYPE_PASSWORD | (r.usernameId != null ? SaveInfo.SAVE_DATA_TYPE_USERNAME : 0);
                SaveInfo.Builder si = new SaveInfo.Builder(types, new AutofillId[] {r.passwordId});
                if (r.usernameId != null) si.setOptionalIds(new AutofillId[] {r.usernameId});
                si.setFlags(SaveInfo.FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE);
                si.setDescription("保存到金匮");
                b.setSaveInfo(si.build());
            }
            callback.onSuccess(b.build());
        } catch (Exception e) {
            // 解析失败不要影响用户正常输入
            AutofillLog.add(this, "填充请求出错：" + e.getClass().getSimpleName() + " " + e.getMessage());
            callback.onSuccess(null);
        }
    }

    @Override
    public void onSaveRequest(SaveRequest request, SaveCallback callback) {
        try {
            FieldParser.Result r = parseLatest(request.getFillContexts());
            AutofillLog.add(this, "保存请求 " + AutofillLog.describe(r) + " 有密码=" + (r.passwordValue != null && !r.passwordValue.isEmpty()));
            if (r.passwordValue == null || r.passwordValue.isEmpty() || Build.VERSION.SDK_INT < 28) {
                // 安卓 8 不能从这里打开界面，只能放弃保存
                callback.onSuccess();
                return;
            }
            PendingSaves.Save s = new PendingSaves.Save();
            s.packageName = r.packageName;
            s.webDomain = r.webDomain;
            s.username = r.usernameValue;
            s.password = r.passwordValue;
            String token = PendingSaves.put(s);
            Intent i = new Intent(this, AutofillActivity.class).putExtra(EXTRA_MODE, "save").putExtra(EXTRA_TOKEN, token);
            int flags = PendingIntent.FLAG_CANCEL_CURRENT | PendingIntent.FLAG_IMMUTABLE;
            IntentSender sender = PendingIntent.getActivity(this, REQUEST_CODE.getAndIncrement(), i, flags).getIntentSender();
            callback.onSuccess(sender);
        } catch (Exception e) {
            AutofillLog.add(this, "保存请求出错：" + e.getClass().getSimpleName() + " " + e.getMessage());
            callback.onFailure("金匮保存失败：" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
        }
    }

    private static FieldParser.Result parseLatest(List<FillContext> contexts) {
        if (contexts == null || contexts.isEmpty()) return new FieldParser.Result();
        AssistStructure s = contexts.get(contexts.size() - 1).getStructure();
        return FieldParser.parse(s);
    }

    private RemoteViews presentation(String text) {
        RemoteViews v = new RemoteViews(getPackageName(), R.layout.autofill_item);
        v.setTextViewText(R.id.autofill_text, text);
        return v;
    }
}
