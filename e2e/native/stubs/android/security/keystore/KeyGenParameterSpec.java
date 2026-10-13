package android.security.keystore; public final class KeyGenParameterSpec implements java.security.spec.AlgorithmParameterSpec {
  public static final class Builder {
    public Builder(String alias, int purposes){}
    public Builder setBlockModes(String... m){ return this; }
    public Builder setEncryptionPaddings(String... p){ return this; }
    public Builder setKeySize(int s){ return this; }
    public Builder setUserAuthenticationRequired(boolean b){ return this; }
    public Builder setInvalidatedByBiometricEnrollment(boolean b){ return this; }
    public Builder setUserAuthenticationParameters(int timeout, int type){ return this; }
    public KeyGenParameterSpec build(){ return new KeyGenParameterSpec(); } } }
