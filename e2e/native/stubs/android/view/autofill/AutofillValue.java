package android.view.autofill; public final class AutofillValue {
  public boolean isText(){ return false; } public CharSequence getTextValue(){ return null; } public static AutofillValue forText(CharSequence t){ return new AutofillValue(); } }
