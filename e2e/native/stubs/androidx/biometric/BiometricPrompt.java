package androidx.biometric; public class BiometricPrompt {
  public static final int ERROR_CANCELED=5, ERROR_LOCKOUT=7, ERROR_LOCKOUT_PERMANENT=9, ERROR_USER_CANCELED=10, ERROR_NEGATIVE_BUTTON=13;
  public static class CryptoObject { private final javax.crypto.Cipher c; public CryptoObject(javax.crypto.Cipher c){ this.c=c; } public javax.crypto.Cipher getCipher(){ return c; } }
  public static class AuthenticationResult { public CryptoObject getCryptoObject(){ return null; } }
  public abstract static class AuthenticationCallback { public void onAuthenticationError(int code, CharSequence msg){} public void onAuthenticationSucceeded(AuthenticationResult r){} public void onAuthenticationFailed(){} }
  public static class PromptInfo { public static class Builder {
    public Builder setTitle(CharSequence t){ return this; } public Builder setSubtitle(CharSequence t){ return this; }
    public Builder setNegativeButtonText(CharSequence t){ return this; } public Builder setAllowedAuthenticators(int a){ return this; }
    public Builder setConfirmationRequired(boolean b){ return this; } public PromptInfo build(){ return new PromptInfo(); } } }
  public BiometricPrompt(androidx.fragment.app.FragmentActivity a, java.util.concurrent.Executor e, AuthenticationCallback cb){}
  public void authenticate(PromptInfo info, CryptoObject co){}
  public void authenticate(PromptInfo info){} }
