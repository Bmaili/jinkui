package app.jinkui.local;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 指纹解锁（规格 6.4）。
 *
 * 在 Android Keystore 里生成一把 AES-256-GCM 密钥：每次使用都要通过强生物识别（BIOMETRIC_STRONG），
 * 录入新指纹后自动失效。保险库密钥用它加密后交给网页保存；解锁时，系统指纹框授权这把密钥解密
 * （BiometricPrompt + CryptoObject），授权和解密是绑在一起的，网页无法跳过指纹拿到明文。
 *
 * JS：registerPlugin('VaultKey')
 *   status() → { available, reason }   reason: ok | none-enrolled | no-hardware | unavailable
 *   enroll({ secret, title, cancel }) → { data }    data = base64(IV 12 字节 + 密文)
 *   unlock({ data, title, cancel }) → { secret }
 *   remove()
 *   seal({ secret }) → { data }     图案解锁（1.0.9 起）的外层：另一把不需要指纹的 Keystore 密钥
 *   open({ data }) → { secret }
 *   removeSeal()
 * 错误码：CANCELLED、INVALIDATED（密钥失效或不存在）、LOCKOUT（试错太多）、FAILED
 *
 * seal / open 用的密钥（SEAL_ALIAS）不要求用户验证，只保证“密文离开这台设备的安全芯片就解不开”：
 * 拷走 app 的文件也没用。里面装的是已经用图案和云端密钥加密过的保险库密钥（规格 6.4），这一层不是唯一的屏障。
 */
@CapacitorPlugin(name = "VaultKey")
public class VaultKeyPlugin extends Plugin {

    private static final String ALIAS = "jinkui-vault-key";
    private static final String SEAL_ALIAS = "jinkui-seal-key";
    private static final String STORE = "AndroidKeyStore";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int AUTH = BiometricManager.Authenticators.BIOMETRIC_STRONG;

    private interface OnCipher {
        void run(Cipher cipher) throws Exception;
    }

    @PluginMethod
    public void status(PluginCall call) {
        int r = BiometricManager.from(getContext()).canAuthenticate(AUTH);
        String reason;
        if (r == BiometricManager.BIOMETRIC_SUCCESS) reason = "ok";
        else if (r == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED) reason = "none-enrolled";
        else if (r == BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE || r == BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE) reason = "no-hardware";
        else reason = "unavailable";
        JSObject ret = new JSObject();
        ret.put("available", r == BiometricManager.BIOMETRIC_SUCCESS);
        ret.put("reason", reason);
        call.resolve(ret);
    }

    @PluginMethod
    public void enroll(final PluginCall call) {
        final String secret = call.getString("secret");
        if (secret == null || secret.isEmpty()) {
            call.reject("没有要保存的内容", "FAILED");
            return;
        }
        final Cipher cipher;
        try {
            deleteKey();
            SecretKey key = createKey();
            cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, key);
        } catch (Exception e) {
            call.reject("无法创建指纹密钥：" + describe(e), "FAILED");
            return;
        }
        prompt(call, cipher, c -> {
            byte[] ct = c.doFinal(secret.getBytes(StandardCharsets.UTF_8));
            byte[] iv = c.getIV();
            byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(out, Base64.NO_WRAP));
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void unlock(final PluginCall call) {
        final byte[] data;
        try {
            data = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
        } catch (Exception e) {
            call.reject("指纹数据损坏", "INVALIDATED");
            return;
        }
        if (data.length <= 12) {
            call.reject("指纹数据损坏", "INVALIDATED");
            return;
        }
        final Cipher cipher;
        try {
            SecretKey key = loadKey();
            if (key == null) {
                call.reject("指纹密钥不存在", "INVALIDATED");
                return;
            }
            cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Arrays.copyOfRange(data, 0, 12)));
        } catch (KeyPermanentlyInvalidatedException e) {
            deleteKey();
            call.reject("指纹密钥已失效", "INVALIDATED");
            return;
        } catch (Exception e) {
            call.reject("无法使用指纹密钥：" + describe(e), "FAILED");
            return;
        }
        prompt(call, cipher, c -> {
            byte[] plain = c.doFinal(Arrays.copyOfRange(data, 12, data.length));
            JSObject ret = new JSObject();
            ret.put("secret", new String(plain, StandardCharsets.UTF_8));
            Arrays.fill(plain, (byte) 0);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        deleteKey();
        call.resolve();
    }

    @PluginMethod
    public void seal(PluginCall call) {
        String secret = call.getString("secret");
        if (secret == null || secret.isEmpty()) {
            call.reject("没有要保存的内容", "FAILED");
            return;
        }
        try {
            SecretKey key = loadSealKey();
            if (key == null) key = createSealKey();
            Cipher c = Cipher.getInstance(TRANSFORM);
            c.init(Cipher.ENCRYPT_MODE, key);
            byte[] ct = c.doFinal(secret.getBytes(StandardCharsets.UTF_8));
            byte[] iv = c.getIV();
            byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(out, Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("无法使用安全芯片里的密钥：" + describe(e), "FAILED");
        }
    }

    @PluginMethod
    public void open(PluginCall call) {
        final byte[] data;
        try {
            data = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
        } catch (Exception e) {
            call.reject("数据损坏", "INVALIDATED");
            return;
        }
        if (data.length <= 12) {
            call.reject("数据损坏", "INVALIDATED");
            return;
        }
        try {
            SecretKey key = loadSealKey();
            if (key == null) {
                call.reject("安全芯片里的密钥不存在", "INVALIDATED");
                return;
            }
            Cipher c = Cipher.getInstance(TRANSFORM);
            c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Arrays.copyOfRange(data, 0, 12)));
            byte[] plain = c.doFinal(Arrays.copyOfRange(data, 12, data.length));
            JSObject ret = new JSObject();
            ret.put("secret", new String(plain, StandardCharsets.UTF_8));
            Arrays.fill(plain, (byte) 0);
            call.resolve(ret);
        } catch (KeyPermanentlyInvalidatedException e) {
            deleteAlias(SEAL_ALIAS);
            call.reject("安全芯片里的密钥已失效", "INVALIDATED");
        } catch (javax.crypto.AEADBadTagException e) {
            // 密钥被重新生成过（例如 removeSeal 之后又 seal），旧密文解不开
            call.reject("数据和安全芯片里的密钥对不上", "INVALIDATED");
        } catch (Exception e) {
            call.reject("无法使用安全芯片里的密钥：" + describe(e), "FAILED");
        }
    }

    @PluginMethod
    public void removeSeal(PluginCall call) {
        deleteAlias(SEAL_ALIAS);
        call.resolve();
    }

    private void prompt(final PluginCall call, final Cipher cipher, final OnCipher onSuccess) {
        final String title = call.getString("title", "解锁");
        final String cancel = call.getString("cancel", "取消");
        getActivity().runOnUiThread(() -> {
            try {
                FragmentActivity activity = (FragmentActivity) getActivity();
                BiometricPrompt prompt = new BiometricPrompt(
                    activity,
                    ContextCompat.getMainExecutor(activity),
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                            BiometricPrompt.CryptoObject co = result.getCryptoObject();
                            if (co == null || co.getCipher() == null) {
                                call.reject("系统没有返回已授权的密钥", "FAILED");
                                return;
                            }
                            try {
                                onSuccess.run(co.getCipher());
                            } catch (Exception e) {
                                call.reject("指纹解锁失败：" + describe(e), "FAILED");
                            }
                        }

                        @Override
                        public void onAuthenticationError(int code, CharSequence message) {
                            String c;
                            if (code == BiometricPrompt.ERROR_USER_CANCELED || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON || code == BiometricPrompt.ERROR_CANCELED) c = "CANCELLED";
                            else if (code == BiometricPrompt.ERROR_LOCKOUT || code == BiometricPrompt.ERROR_LOCKOUT_PERMANENT) c = "LOCKOUT";
                            else c = "FAILED";
                            call.reject(message == null ? "指纹验证失败" : message.toString(), c);
                        }
                        // onAuthenticationFailed：单次没认出来，系统框会提示再试，这里不用处理
                    }
                );
                BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setNegativeButtonText(cancel)
                    .setAllowedAuthenticators(AUTH)
                    .setConfirmationRequired(false)
                    .build();
                prompt.authenticate(info, new BiometricPrompt.CryptoObject(cipher));
            } catch (Exception e) {
                call.reject(describe(e), "FAILED");
            }
        });
    }

    private SecretKey createKey() throws Exception {
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // 每次使用都要验证，而且只认强生物识别（不接受锁屏密码代替）
            b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        }
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE);
        g.init(b.build());
        return g.generateKey();
    }

    /** 图案解锁的外层密钥：不要求用户验证（图案由网页里的 scrypt 和云端密钥把关），导不出安全芯片 */
    private SecretKey createSealKey() throws Exception {
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(SEAL_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256);
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE);
        g.init(b.build());
        return g.generateKey();
    }

    private SecretKey loadKey() throws Exception {
        return loadAlias(ALIAS);
    }

    private SecretKey loadSealKey() throws Exception {
        return loadAlias(SEAL_ALIAS);
    }

    private SecretKey loadAlias(String alias) throws Exception {
        KeyStore ks = KeyStore.getInstance(STORE);
        ks.load(null);
        return (SecretKey) ks.getKey(alias, null);
    }

    private void deleteKey() {
        deleteAlias(ALIAS);
    }

    private void deleteAlias(String alias) {
        try {
            KeyStore ks = KeyStore.getInstance(STORE);
            ks.load(null);
            if (ks.containsAlias(alias)) ks.deleteEntry(alias);
        } catch (Exception ignored) {
            // 删不掉也不影响：下次会重新生成
        }
    }

    private static String describe(Exception e) {
        return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
    }
}
